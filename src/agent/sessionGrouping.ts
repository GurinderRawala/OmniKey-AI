import { Op } from 'sequelize';
import { z } from 'zod';
import { AgentSession } from '../models/agentSession';
import { Subscription } from '../models/subscription';
import { aiClient, getDefaultModel } from '../ai-client';
import { config } from '../config';
import { logger } from '../logger';

const aiModel = getDefaultModel(config.aiProvider, 'fast');

// ---------------------------------------------------------------------------
// Extract user_input text from persisted session history
// ---------------------------------------------------------------------------

function extractUserInputs(historyJson: string): string[] {
  try {
    const history = JSON.parse(historyJson) as Array<{ role: string; content: unknown }>;
    const inputs: string[] = [];

    for (const msg of history) {
      if (msg.role !== 'user') continue;
      const raw = typeof msg.content === 'string' ? msg.content : '';
      if (!raw) continue;

      // Skip injected feedback/control messages
      if (raw.startsWith('TERMINAL OUTPUT:')) continue;
      if (raw.startsWith('COMMAND ERROR:')) continue;
      if (raw.startsWith('Web research is complete')) continue;
      if (raw.startsWith('IMPORTANT: The web search tool failed')) continue;
      if (raw.startsWith('Content was truncated')) continue;
      if (raw.includes('<stored_instructions>')) continue;

      // Extract the inner text from <user_input> wrapper if present
      const match = /<user_input>([\s\S]*?)<\/user_input>/i.exec(raw);
      const text = match ? match[1].trim() : raw.trim();

      const cleaned = text.replace(/@omniagent\s*/gi, '').trim();
      if (cleaned.length > 5) {
        inputs.push(cleaned.slice(0, 400));
      }
    }

    return inputs.slice(0, 8);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Extract the deepest meaningful project root from absolute paths in text.
// Strategy: find all /abs/path segments, resolve the most commonly referenced
// root (stops at depth 4 from /, so ~/projects/foo/src/bar → ~/projects/foo).
// ---------------------------------------------------------------------------

function extractProjectPath(texts: string[]): string | null {
  const combined = texts.join(' ');

  // Match absolute paths (Unix) — capture up to 5 path segments
  const pathRe = /(\/(?:[^\s/<>"'`]+\/){1,5}[^\s/<>"'`]*)/g;
  const matches = Array.from(combined.matchAll(pathRe), (m) => m[1]);

  if (!matches.length) return null;

  // Score candidate roots by frequency: walk up each path up to depth 5
  // counting how many times each ancestor appears across all matches.
  const score = new Map<string, number>();
  for (const p of matches) {
    const parts = p.split('/').filter(Boolean);
    // Build ancestors from depth 2 up to depth 5 (skip / and single-segment)
    for (let depth = 2; depth <= Math.min(5, parts.length); depth++) {
      const candidate = '/' + parts.slice(0, depth).join('/');
      score.set(candidate, (score.get(candidate) ?? 0) + 1);
    }
  }

  // Prefer the deepest path that still has a frequency >= half the top score
  const entries = Array.from(score.entries()).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;

  const topScore = entries[0][1];
  const threshold = Math.max(1, Math.floor(topScore / 2));

  // Among candidates meeting the threshold, pick the deepest (most segments)
  const qualified = entries
    .filter(([, s]) => s >= threshold)
    .sort((a, b) => b[0].split('/').length - a[0].split('/').length);

  return qualified[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Build a deterministic 3-4 sentence description from the project path.
// Used as a fallback when the LLM does not return a usable description.
// When a project path is available it is included verbatim so downstream
// agent prompts can rely on it as the project root.
// ---------------------------------------------------------------------------

function buildDescription(projectPath: string | null, groupName: string): string {
  if (!projectPath) {
    return [
      `You are working on the ${groupName} project.`,
      `This group collects sessions related to ${groupName}.`,
      `No specific file path has been associated with this group yet.`,
      `Use this context to keep responses focused on the ${groupName} topic.`,
    ].join(' ');
  }
  const projectName = projectPath.split('/').filter(Boolean).pop() ?? groupName;
  return [
    `You are working in ${projectPath} — the ${projectName} project.`,
    `This group collects sessions related to the ${projectName} codebase.`,
    `Treat ${projectPath} as the project root when interpreting file references and commands.`,
    `Keep responses scoped to this project's structure and conventions.`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// LLM: classify group name AND generate a 3-4 sentence description for new
// groups. For existing groups the stored description is always reused — the
// LLM only writes a description when this is a genuinely new group. The
// description must include the absolute project root path whenever one is
// present in the user inputs.
// ---------------------------------------------------------------------------

interface GroupResult {
  groupName: string;
  groupDescription: string;
}

async function classifyGroup(
  userInputs: string[],
  existingGroups: Array<{ groupName: string; groupDescription: string | null }>,
): Promise<GroupResult | null> {
  if (!userInputs.length) return null;

  const existingText = existingGroups.length
    ? existingGroups.map((g) => `- "${g.groupName}"`).join('\n')
    : 'None.';

  const prompt = `Analyze these chat messages and assign a project group.

Messages:
${userInputs.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Existing groups:
${existingText}

Rules:
1. Look for file system paths, repository names, or project names in the messages.
2. Identify the root project — if "/Users/john/projects/my-app/src/file.ts" appears, the group is "my-app".
3. If an existing group clearly matches, return its EXACT name.
4. Otherwise create a concise group name: 2-4 words, Title Case (e.g. "OmniKey AI", "Music Video Editor", "Client Website").
5. ALWAYS write a 3-4 sentence description (roughly 3-4 lines, 250-500 characters) that explains:
   - what the project / group is about,
   - the kind of work that happens in these sessions,
   - any relevant tech stack, repo, or domain hints inferred from the messages,
   - and the absolute file path of the project root when one is present in the messages.
   If a file path is found, you MUST include the exact absolute path verbatim in the description (e.g. "Project root: /Users/john/projects/my-app."). Start the description with "You are working in <path> — the <project-name> project." when a path is available, otherwise start with "You are working on the <project-name> project.". Do not use markdown, bullet points, or newlines — keep it as a single paragraph.
6. If no paths exist and the session is purely general/conversational, use group name "General" and still produce a 3-4 sentence description summarizing the recurring topic.

Respond with ONLY valid JSON, no markdown:
{"groupName":"...","groupDescription":"..."}`;

  try {
    const result = await aiClient.complete(
      aiModel,
      [
        {
          role: 'system',
          content:
            'You are a session categorization assistant. Respond only with the requested JSON object, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    );

    const raw = result.content
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();

    const parsed: unknown = JSON.parse(raw);
    const response = z
      .object({ groupName: z.string(), groupDescription: z.string() })
      .parse(parsed);
    const groupName = response.groupName.trim().slice(0, 100);
    if (!groupName) return null;

    // If this matches an existing group, always reuse the stored description.
    const existingMatch = existingGroups.find(
      (g) => g.groupName.toLowerCase() === groupName.toLowerCase(),
    );
    if (existingMatch) {
      const groupDescription =
        existingMatch.groupDescription ??
        buildDescription(extractProjectPath(userInputs), groupName);
      return { groupName: existingMatch.groupName, groupDescription };
    }

    // New group: prefer the LLM description but fall back to the deterministic builder.
    // Description is now a 3-4 sentence paragraph (no newlines, capped at 1000 chars
    // to leave headroom over the ~500 char target while still bounding storage).
    const rawDesc = response.groupDescription.trim();
    const projectPath = extractProjectPath(userInputs);
    let groupDescription = (rawDesc || buildDescription(projectPath, groupName))
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Safety net: if the LLM ignored the rule and a path exists in the messages
    // but is missing from the description, append it so the contract holds.
    if (projectPath && !groupDescription.includes(projectPath)) {
      groupDescription = `${groupDescription} Project root: ${projectPath}.`.trim();
    }

    groupDescription = groupDescription.slice(0, 1000);

    return { groupName, groupDescription };
  } catch (err) {
    logger.warn('Session group classification failed', { error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: update one session's group
// ---------------------------------------------------------------------------

export async function updateSessionGroup(sessionId: string, subscriptionId: string): Promise<void> {
  try {
    const session = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId },
      attributes: ['id', 'historyJson'],
    });
    if (!session) return;

    const inputs = extractUserInputs(session.historyJson);
    if (!inputs.length) return;

    // Fetch existing distinct groups (by name) to encourage reuse
    const rows = await AgentSession.findAll({
      where: {
        subscriptionId,
        groupName: { [Op.not]: null },
        id: { [Op.ne]: sessionId },
      },
      attributes: ['groupName', 'groupDescription'],
      group: ['group_name'],
      limit: 50,
    });

    const existingGroups = rows
      .filter((s) => s.groupName)
      .map((s) => ({
        groupName: s.groupName!,
        groupDescription: s.groupDescription ?? null,
      }));

    const result = await classifyGroup(inputs, existingGroups);
    if (!result) return;

    await AgentSession.update(
      { groupName: result.groupName, groupDescription: result.groupDescription },
      { where: { id: sessionId } },
    );

    logger.info('Session group updated', { sessionId, groupName: result.groupName });
  } catch (err) {
    logger.error('Failed to update session group', { sessionId, error: err });
  }
}

// ---------------------------------------------------------------------------
// Public: refresh all sessions for a subscription (used by cron)
// ---------------------------------------------------------------------------

export async function refreshAllSessionGroups(subscriptionId: string): Promise<void> {
  try {
    const sessions = await AgentSession.findAll({
      where: { subscriptionId },
      order: [['last_active_at', 'DESC']],
      limit: 50,
      attributes: ['id', 'historyJson'],
    });

    logger.info('Refreshing session groups', {
      subscriptionId,
      count: sessions.length,
    });

    for (const session of sessions) {
      await updateSessionGroup(session.id, subscriptionId);
    }
  } catch (err) {
    logger.error('Failed to refresh session groups for subscription', {
      subscriptionId,
      error: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Cron: run every 6 hours across all subscriptions
// ---------------------------------------------------------------------------

export function startGroupingCronJob(): void {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

  const tick = async () => {
    try {
      const subscriptions = await Subscription.findAll({ attributes: ['id'] });
      logger.info('Running session grouping cron', {
        subscriptionCount: subscriptions.length,
      });
      for (const sub of subscriptions) {
        await refreshAllSessionGroups(sub.id);
      }
    } catch (err) {
      logger.error('Session grouping cron failed', { error: err });
    }
  };

  setInterval(() => void tick(), SIX_HOURS_MS);
  logger.info('Session grouping cron started (6h interval)');

  // If no session has a group yet (e.g. first startup after the feature was
  // added, or a fresh self-hosted install with existing sessions), run the
  // full backfill immediately rather than waiting 6 hours.
  void (async () => {
    try {
      const ungrouped = await AgentSession.count({ where: { groupName: null } });
      const grouped = await AgentSession.count({ where: { groupName: { [Op.not]: null } } });
      if (ungrouped > 0 && grouped === 0) {
        logger.info('No sessions have a group yet — running initial grouping backfill', {
          sessionCount: ungrouped,
        });
        await tick();
      }
    } catch (err) {
      logger.error('Initial grouping backfill check failed', { error: err });
    }
  })();
}
