import { Op } from 'sequelize';
import { AgentSession } from '../../../models/agentSession';
import { Subscription } from '../../../models/subscription';
import { logger } from '../../../logger';
import type { AgentSendFn } from '../../types';
import { extractProjectPath, extractStoredProjectPath, extractUserInputs } from '../utils';
import {
  ASSIGN_SESSION_GROUPS_TOOL,
  createAssignSessionGroupsHandler,
} from './assignSessionGroupsTool';

// Sessions this module spins up to drive the grouping agent are named with this
// prefix + the subscription id, so they are (a) stable (one per subscription,
// reused/cleared each pass) and (b) easy to exclude from the user-facing
// session list and from grouping itself.
export const GROUPING_SESSION_PREFIX = 'grouping-';

export function groupingSessionId(subscriptionId: string): string {
  return `${GROUPING_SESSION_PREFIX}${subscriptionId}`;
}

// How much context we hand the agent, kept bounded so the prompt stays cheap.
// Every session must be grouped now, so allow a larger batch per pass to clear
// a backlog in fewer ticks (still bounded by the 50-session fetch below).
const MAX_UNGROUPED = 40;
const MAX_GROUPED_TO_SUMMARISE = 15;
const MAX_SNIPPETS_PER_SESSION = 3;
const GROUPING_AGENT_TIMEOUT_MS = 5 * 60 * 1_000;
const FINAL_ANSWER_RE = /<final_answer>/;

function snippetFor(historyJson: string): string {
  const inputs = extractUserInputs(historyJson);
  if (!inputs.length) return '(no user text)';
  return inputs.slice(0, MAX_SNIPPETS_PER_SESSION).join(' | ').replace(/\s+/g, ' ').slice(0, 500);
}

interface GatheredContext {
  prompt: string;
  allowedSessionIds: Set<string>;
  existingGroupNames: Set<string>;
  hasWork: boolean;
}

/**
 * Pull up to 50 recent sessions for the subscription and assemble the agent's
 * task prompt: existing groups (with their stored root + recent activity) and
 * the ungrouped sessions that need classifying, each anchored by a
 * deterministic project-root guess.
 */
async function gatherContext(subscriptionId: string): Promise<GatheredContext> {
  const sessions = await AgentSession.findAll({
    where: {
      subscriptionId,
      // Never feed the grouping helper sessions back into grouping.
      id: { [Op.notLike]: `${GROUPING_SESSION_PREFIX}%` },
    },
    order: [['last_active_at', 'DESC']],
    limit: 50,
    attributes: ['id', 'title', 'groupName', 'groupDescription', 'sessionSummary', 'historyJson'],
  });

  const grouped = sessions.filter((s) => s.groupName);
  const ungrouped = sessions.filter((s) => !s.groupName).slice(0, MAX_UNGROUPED);

  const existingGroupNames = new Set<string>();
  const byGroup = new Map<
    string,
    { description: string | null; storedPath: string | null; members: AgentSession[] }
  >();
  for (const s of grouped) {
    const name = s.groupName!;
    existingGroupNames.add(name);
    if (!byGroup.has(name)) {
      byGroup.set(name, {
        description: s.groupDescription ?? null,
        storedPath: extractStoredProjectPath(s.groupDescription),
        members: [],
      });
    }
    byGroup.get(name)!.members.push(s);
  }

  const allowedSessionIds = new Set<string>();

  // Existing groups block.
  const groupBlocks: string[] = [];
  for (const [name, info] of byGroup.entries()) {
    const recent = info.members.slice(0, 4);
    const activity = recent.map((m) => `      • ${snippetFor(m.historyJson)}`).join('\n');
    groupBlocks.push(
      [
        `- Group "${name}" (${info.members.length} session(s))`,
        `    Stored project root: ${info.storedPath ?? '(none recorded)'}`,
        `    Current description: ${info.description ? info.description.slice(0, 400) : '(none yet)'}`,
        `    Recent activity:`,
        activity || '      • (none)',
      ].join('\n'),
    );
  }

  // Grouped sessions still missing a per-session summary — the agent can fill
  // these in the same pass (their group is NOT changed).
  const groupedNeedingSummary = grouped
    .filter((s) => !s.sessionSummary)
    .slice(0, MAX_GROUPED_TO_SUMMARISE);
  const summaryBlocks: string[] = [];
  for (const s of groupedNeedingSummary) {
    allowedSessionIds.add(s.id);
    summaryBlocks.push(
      `- sessionId=${s.id} group="${s.groupName}"\n    Activity: ${snippetFor(s.historyJson)}`,
    );
  }

  // Ungrouped sessions to classify.
  const ungroupedBlocks: string[] = [];
  for (const s of ungrouped) {
    allowedSessionIds.add(s.id);
    const inputs = extractUserInputs(s.historyJson);
    const guess = extractProjectPath(inputs);
    ungroupedBlocks.push(
      [
        `- sessionId=${s.id}`,
        `    Detected project root (deterministic guess, may be wrong): ${guess ?? '(none detected)'}`,
        `    Activity: ${snippetFor(s.historyJson)}`,
      ].join('\n'),
    );
  }

  const hasWork = ungrouped.length > 0 || groupBlocks.length > 0 || summaryBlocks.length > 0;

  const prompt = [
    'You are organising this user\'s agent chat sessions into groups. Most groups correspond to a single',
    'project (one project root directory); distinct projects — including a parent repo and a child package',
    'inside it (e.g. /Users/me/Repo vs /Users/me/Repo/api) — are DIFFERENT groups. When a session is not',
    'about a codebase, group it by its TOPIC instead (e.g. "Postgres Migration", "Prompt Tuning",',
    '"Release Chores", "Ads Campaign").',
    '',
    'You have the shell_script tool. When a project root is proposed, you MAY verify it exists on disk',
    '(e.g. `test -d "<path>" && echo EXISTS || echo MISSING`). Paths might not exist in this environment;',
    'if verification is inconclusive, use the deterministic guess provided. Prefer a verified path.',
    '',
    '=== EXISTING GROUPS ===',
    groupBlocks.length ? groupBlocks.join('\n') : '(none yet)',
    '',
    '=== GROUPED SESSIONS MISSING A SUMMARY (do NOT change their group; just summarise) ===',
    summaryBlocks.length ? summaryBlocks.join('\n') : '(none)',
    '',
    '=== UNGROUPED SESSIONS TO CLASSIFY ===',
    ungroupedBlocks.length ? ungroupedBlocks.join('\n') : '(none)',
    '',
    'Rules:',
    '1. Assign EVERY ungrouped session listed above to a group. Do NOT leave any session ungrouped and do',
    '   NOT omit any from the `sessions` list — every session id above must appear exactly once.',
    '2. Reuse an existing group when the session belongs to the same project or topic. Otherwise create a',
    '   new SPECIFIC group name (2-4 words, Title Case) describing the project (from its path/product) or,',
    '   when there is no codebase, the session\'s topic/subject. Prefer putting related sessions in the same',
    '   group; a small or single-session group is fine when nothing else matches.',
    '3. NEVER use a generic catch-all name. Names like "Other", "Miscellaneous", "General", "Uncategorized",',
    '   "Various", "Stuff", or anything that just means "everything else" are FORBIDDEN and will be rejected.',
    '   Always pick a concrete, descriptive name — even a one-session group is better than a catch-all.',
    '4. Never move a session that already has a group.',
    '5. For every group that has sessions, provide a refreshed 3-5 sentence description and its verified',
    '   absolute project root (or null when the group is topic-based rather than a codebase).',
    '6. Give every session a one-sentence summary of what the user did in it.',
    '',
    'When ready, call assign_session_groups EXACTLY ONCE with your full decision — every ungrouped session',
    'assigned to a specific group — then reply with <final_answer>done</final_answer>. Do not ask anything.',
  ].join('\n');

  return { prompt, allowedSessionIds, existingGroupNames, hasWork };
}

/**
 * Run one grouping pass for a subscription by driving the full agent
 * (runAgentTurn) with the assign_session_groups tool. This replaces the old
 * per-group + per-session cascade of small LLM calls with a single agent turn
 * that sees every session at once and can verify project roots on disk.
 */
export async function regroupSubscriptionViaAgent(subscriptionId: string): Promise<void> {
  const gid = groupingSessionId(subscriptionId);
  try {
    const subscription = await Subscription.findByPk(subscriptionId);
    if (!subscription) return;

    const { prompt, allowedSessionIds, existingGroupNames, hasWork } =
      await gatherContext(subscriptionId);
    if (!hasWork) {
      logger.debug('Grouping agent: nothing to do for subscription', { subscriptionId });
      return;
    }

    // Clear any stale grouping session so the agent starts from a clean slate.
    await AgentSession.destroy({ where: { id: gid, subscriptionId } });

    const handler = createAssignSessionGroupsHandler({
      subscriptionId,
      allowedSessionIds,
      existingGroupNames,
    });

    // Lazy import breaks the agentServer ⇄ sessionGrouping module cycle: the
    // agent imports sessionGrouping at load time, so sessionGrouping must not
    // statically import the agent back.
    const { runAgentTurn } = await import('../../agentServer');

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        logger.warn('Grouping agent timed out', { subscriptionId });
        settle();
      }, GROUPING_AGENT_TIMEOUT_MS);

      const send: AgentSendFn = (msg) => {
        if (settled) return;
        const content = msg.content ?? '';
        if (msg.is_error) {
          logger.warn('Grouping agent reported an error', {
            subscriptionId,
            content: content.slice(0, 300),
          });
          settle();
          return;
        }
        // Progress notifications (tool calls, shell output requests) — keep waiting.
        if (msg.is_web_call || msg.is_image_rendering || msg.is_mcp_call) return;
        if (FINAL_ANSWER_RE.test(content) || content.trim()) {
          settle();
        }
      };

      void runAgentTurn(
        gid,
        subscription,
        { session_id: gid, sender: 'user', content: prompt },
        send,
        logger,
        {
          isCronJob: true,
          skipGrouping: true,
          extraTools: [ASSIGN_SESSION_GROUPS_TOOL],
          toolHandlers: new Map([['assign_session_groups', handler]]),
        },
      ).catch((err) => {
        logger.error('Grouping agent turn failed', { subscriptionId, error: err });
        settle();
      });
    });

    logger.info('Grouping agent pass completed', {
      subscriptionId,
      ungroupedConsidered: allowedSessionIds.size,
      existingGroups: existingGroupNames.size,
    });
  } catch (err) {
    logger.error('regroupSubscriptionViaAgent failed', { subscriptionId, error: err });
  } finally {
    // Always remove the helper session so it never lingers in the user's list.
    await AgentSession.destroy({ where: { id: gid, subscriptionId } }).catch(() => {});
  }
}
