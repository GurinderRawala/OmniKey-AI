import { z } from 'zod';
import { Logger } from 'winston';
import { AITool } from '../../../ai-client';
import { AgentSession } from '../../../models/agentSession';
import { extractStoredProjectPath, isCatchAllGroupName } from '../utils';

/**
 * The single tool the grouping agent calls to write its decisions back to the
 * database. Everything the agent decides in one cron pass — which ungrouped
 * session belongs to which group, each group's refreshed description + verified
 * project root, and per-session activity summaries — is applied through here in
 * ONE call.
 *
 * All of the safety invariants live in the handler, NOT the prompt:
 *   - A session is only ever assigned a group if it is currently UNGROUPED and
 *     not user-locked. Already-grouped sessions are never moved (one project =
 *     one group; the user's grouping choices are respected).
 *   - Only sessions that were presented to the agent this pass can be touched.
 *   - Group descriptions can only be (re)written for groups that actually exist
 *     or that gained a member in this same call.
 */
export const ASSIGN_SESSION_GROUPS_TOOL: AITool = {
  name: 'assign_session_groups',
  description:
    'Write the final grouping for this pass. Call EXACTLY ONCE with: (1) `groups` — for every ' +
    'project group, its name, the verified absolute project root on disk (or null if none), and a ' +
    'concise 3-5 sentence description; (2) `sessions` — for each UNGROUPED session id you were ' +
    'given, the group name it belongs to and a one-sentence summary of what the user did in it. ' +
    'Do NOT list sessions that already have a group. The server enforces that already-grouped and ' +
    'user-locked sessions are never moved.',
  parameters: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        description: 'One entry per project group referenced by the sessions below.',
        items: {
          type: 'object',
          properties: {
            groupName: { type: 'string', description: 'The exact group name (2-4 words, Title Case).' },
            projectRoot: {
              type: ['string', 'null'],
              description:
                'The verified absolute filesystem project root, or null if none applies. Use the ' +
                'exact path you confirmed exists on disk.',
            },
            description: {
              type: 'string',
              description:
                'A single paragraph (3-5 sentences, no markdown) describing the project: its purpose, ' +
                'primary language, and recent themes across its sessions.',
            },
          },
          required: ['groupName', 'description'],
        },
      },
      sessions: {
        type: 'array',
        description: 'One entry per UNGROUPED session you were asked to classify.',
        items: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'The session id, verbatim.' },
            groupName: {
              type: 'string',
              description: 'The group name this session belongs to (must appear in `groups`).',
            },
            summary: {
              type: 'string',
              description: 'One short sentence: what the user worked on in this session.',
            },
          },
          required: ['sessionId', 'groupName'],
        },
      },
    },
    required: ['sessions'],
  },
};

const argsSchema = z.object({
  groups: z
    .array(
      z.object({
        groupName: z.string(),
        projectRoot: z.string().nullish(),
        description: z.string(),
      }),
    )
    .optional()
    .default([]),
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        groupName: z.string(),
        summary: z.string().nullish(),
      }),
    )
    .optional()
    .default([]),
});

/**
 * Ensure a group description carries the verified project root as its leading
 * `Project root: <path>.` sentence, since that is the anchor
 * extractStoredProjectPath / buildProjectContext read back. Replaces any path
 * the model wrote that disagrees with the verified root; prepends one when the
 * model omitted it entirely.
 */
function normaliseDescription(description: string, projectRoot: string | null | undefined): string {
  const cleaned = description.trim().replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!projectRoot) return cleaned;

  const existing = extractStoredProjectPath(cleaned);
  if (existing === projectRoot) return cleaned;

  const withoutRoot = cleaned.replace(/^Project root:\s*\S+\.?\s*/i, '').trim();
  return `Project root: ${projectRoot}. ${withoutRoot}`.trim();
}

/**
 * Build the handler bound to a single subscription + the exact set of sessions
 * and group names presented to the agent this pass. Returns a function matching
 * agentServer's CustomToolHandler shape.
 */
export function createAssignSessionGroupsHandler(params: {
  subscriptionId: string;
  allowedSessionIds: Set<string>;
  existingGroupNames: Set<string>;
}): (args: Record<string, unknown>, log: Logger) => Promise<string> {
  const { subscriptionId, allowedSessionIds, existingGroupNames } = params;

  return async (rawArgs, log) => {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      log.warn('assign_session_groups: invalid arguments', { error: parsed.error.message });
      return `Error: invalid arguments. ${parsed.error.message}`;
    }
    const { groups, sessions } = parsed.data;

    let assigned = 0;
    let skippedGrouped = 0;
    let skippedUnknown = 0;
    let skippedCatchAll = 0;
    let summarised = 0;
    const groupsGainingMembers = new Set<string>();

    // 1) Assign ungrouped sessions to groups (and record summaries). We fetch
    //    each session's current state and only write when it is genuinely
    //    ungrouped and unlocked — the model cannot override this.
    for (const s of sessions) {
      const groupName = s.groupName.trim().slice(0, 100);
      if (!allowedSessionIds.has(s.sessionId)) {
        skippedUnknown++;
        continue;
      }
      const row = await AgentSession.findOne({
        where: { id: s.sessionId, subscriptionId },
        attributes: ['id', 'groupName', 'groupLocked'],
      });
      if (!row) {
        skippedUnknown++;
        continue;
      }

      const summary = s.summary?.trim().slice(0, 320) || null;

      // Refuse catch-all buckets ("Other", "Misc", "General", …). A session
      // that doesn't clearly belong to a real project is LEFT UNGROUPED — a
      // later pass can classify it once there's a clearer signal. We still keep
      // any summary the agent produced.
      if (groupName && isCatchAllGroupName(groupName)) {
        skippedCatchAll++;
        if (summary && !row.groupName) {
          await AgentSession.update({ sessionSummary: summary }, { where: { id: s.sessionId } });
          summarised++;
        }
        continue;
      }

      const canAssign = groupName && !row.groupName && !row.groupLocked;

      if (canAssign) {
        await AgentSession.update(
          { groupName, ...(summary ? { sessionSummary: summary } : {}) },
          { where: { id: s.sessionId } },
        );
        assigned++;
        groupsGainingMembers.add(groupName);
        if (summary) summarised++;
      } else {
        // Already grouped or locked — never move it, but a fresh summary is
        // still useful for buildProjectContext.
        if (row.groupName) skippedGrouped++;
        if (summary) {
          await AgentSession.update({ sessionSummary: summary }, { where: { id: s.sessionId } });
          summarised++;
        }
      }
    }

    // 2) Refresh group descriptions. Only for groups that already existed or
    //    that just gained a member — never conjure a description for a group
    //    with no sessions.
    let describedGroups = 0;
    for (const g of groups) {
      const groupName = g.groupName.trim().slice(0, 100);
      if (!groupName) continue;
      if (isCatchAllGroupName(groupName)) continue;
      if (!existingGroupNames.has(groupName) && !groupsGainingMembers.has(groupName)) {
        continue;
      }
      const description = normaliseDescription(g.description, g.projectRoot).slice(0, 1200);
      if (!description) continue;
      // Description is group-level metadata, so it applies to every session in
      // the group (locked members included — locking guards membership, not the
      // shared description).
      const [count] = await AgentSession.update(
        { groupDescription: description, groupDescriptionUpdatedAt: new Date() },
        { where: { subscriptionId, groupName } },
      );
      if (count > 0) describedGroups++;
    }

    log.info('assign_session_groups applied', {
      subscriptionId,
      assigned,
      skippedGrouped,
      skippedUnknown,
      skippedCatchAll,
      summarised,
      describedGroups,
    });

    return (
      `Applied grouping: assigned ${assigned} session(s) to groups, ` +
      `wrote ${describedGroups} group description(s), ${summarised} session summary(ies). ` +
      `Left ${skippedCatchAll} session(s) ungrouped (catch-all group names are not allowed). ` +
      `Skipped ${skippedGrouped} already-grouped and ${skippedUnknown} unknown session(s). ` +
      `You are done — respond with <final_answer>done</final_answer>.`
    );
  };
}
