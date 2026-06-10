import { Op } from 'sequelize';
import { z } from 'zod';
import { AgentSession } from '../models/agentSession';
import { Subscription } from '../models/subscription';
import { aiClient, getDefaultModel } from '../ai-client';
import { config } from '../config';
import { logger } from '../logger';

const aiModel = getDefaultModel(config.aiProvider, 'fast');

// ---------------------------------------------------------------------------
// Strip response wrappers before JSON.parse
// ---------------------------------------------------------------------------

/** Remove <final_answer> tags and markdown code fences that some models wrap
 *  around JSON responses, leaving only the raw JSON text. */
function stripResponseWrappers(text: string): string {
  return text
    .trim()
    .replace(/^<final_answer>\s*/i, '')
    .replace(/\s*<\/final_answer>$/i, '')
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

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
// Deterministic 3-sentence fallback description.
// The description always answers, in order:
//   1. Where is the project root located?
//   2. What is the purpose of this project?
//   3. If it is a coding project, what is the primary programming language?
// Used when the LLM does not return a usable description.
// ---------------------------------------------------------------------------

function buildDescription(projectPath: string | null, groupName: string): string {
  if (projectPath) {
    return [
      `Project root: ${projectPath} (the ${groupName} project).`,
      `Purpose: ongoing work on the ${groupName} codebase.`,
      `Primary language: not yet determined from session context.`,
    ].join(' ');
  }
  return [
    `Project root: not specified — no absolute path has been associated with the ${groupName} group yet.`,
    `Purpose: sessions grouped under ${groupName}.`,
    `Primary language: not applicable (no coding project identified).`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// LLM: classify group name AND generate a 3-4 sentence description for new
// groups. For existing groups the stored description is always reused — the
// LLM only writes a description when this is a genuinely new group. The
// description must answer the three required questions and include the
// absolute project root path whenever one is present in the user inputs.
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

Rules for the group name:
1. Look for file system paths, repository names, or project names in the messages.
2. Identify the root project — if "/Users/john/projects/my-app/src/file.ts" appears, the group is "my-app".
3. If an existing group clearly matches, return its EXACT name.
4. Otherwise create a concise group name: 2-4 words, Title Case (e.g. "OmniKey AI", "Music Video Editor", "Client Website").
5. If the session is purely general/conversational with no project signal, use "General".

Rules for the description (CRITICAL):
The description is appended to user input as <project_context> whenever the user picks this project, so it must be short, factual, and load-bearing. Write a SINGLE paragraph of 3-4 sentences (max 4 sentences, no markdown, no bullet points, no newlines) that answers these three questions in order:
   1. Where is the project root located? Quote the exact absolute path verbatim when one is present in the messages (e.g. "Project root: /Users/john/projects/my-app."). If no path is present, say so explicitly.
   2. What is the purpose of this project? One sentence summarising what the project / group is for, inferred from the messages.
   3. If it is a coding project, what is the primary programming language? Name the language (e.g. TypeScript, Python, Go, Rust) when it can be inferred from file extensions, framework names, package files, or explicit mentions. If it is not a coding project, say "Not a coding project." If the language cannot be inferred, say "Primary language not identified from the available context."
Keep the whole description under ~500 characters. Do NOT add extra commentary, tech-stack lists, workflow notes, or session summaries beyond what the three questions require.

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

    const raw = stripResponseWrappers(result.content);

    const parsed: unknown = JSON.parse(raw);
    const response = z
      .object({ groupName: z.string(), groupDescription: z.string() })
      .parse(parsed);
    const groupName = response.groupName.trim().slice(0, 100);
    if (!groupName) return null;

    // When we fall through from the existingMatch branch to regenerate a stale
    // description, preserve the canonical existing group name so we don't
    // fragment groups by re-casing the name.
    let canonicalName: string | null = null;

    // If this matches an existing group, reuse the stored description ONLY when it
    // already follows the new shape (must mention "Project root" and "Primary
    // language"). Otherwise fall through and let the LLM-generated description
    // replace it, so old verbose descriptions are upgraded in place.
    const existingMatch = existingGroups.find(
      (g) => g.groupName.toLowerCase() === groupName.toLowerCase(),
    );
    if (existingMatch) {
      const stored = existingMatch.groupDescription ?? '';
      const hasNewShape = /project root/i.test(stored) && /primary language/i.test(stored);
      if (hasNewShape) {
        return { groupName: existingMatch.groupName, groupDescription: stored };
      }
      // Fall through: regenerate description using the LLM output below, but
      // keep the canonical existing group name so we don't fragment groups.
      canonicalName = existingMatch.groupName;
    }

    // New group: prefer the LLM description but fall back to the deterministic builder.
    // Description is a single 3-4 sentence paragraph (no newlines, capped at 800 chars
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
      groupDescription = `Project root: ${projectPath}. ${groupDescription}`.trim();
    }

    groupDescription = groupDescription.slice(0, 800);

    return {
      // Preserve the canonical existing group name when we fell through from
      // the existingMatch branch to regenerate a stale description.
      groupName: canonicalName ?? groupName,
      groupDescription,
    };
  } catch (err) {
    logger.warn('Session group classification failed', { error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch up to 10 recent user inputs from sessions already in a group.
// Used to give the LLM richer context about the group when classifying a
// new session or when refreshing a description via the cron job.
// ---------------------------------------------------------------------------

async function fetchSiblingInputs(
  subscriptionId: string,
  groupName: string,
  excludeSessionId?: string,
): Promise<string[]> {
  const sessions = await AgentSession.findAll({
    where: excludeSessionId
      ? { subscriptionId, groupName, id: { [Op.ne]: excludeSessionId } }
      : { subscriptionId, groupName },
    order: [['last_active_at', 'DESC']],
    limit: 15,
    attributes: ['historyJson'],
  });

  const collected: string[] = [];
  for (const s of sessions) {
    for (const inp of extractUserInputs(s.historyJson)) {
      collected.push(inp);
      if (collected.length >= 10) break;
    }
    if (collected.length >= 10) break;
  }

  return collected;
}

// ---------------------------------------------------------------------------
// LLM: generate or update a group description using combined inputs.
// When isUpdateMode is true the LLM is asked to UPDATE the existing
// description with new findings rather than write one from scratch.
// ---------------------------------------------------------------------------

async function enrichGroupDescription(
  groupName: string,
  allInputs: string[],
  existingDescription: string | null,
  isUpdateMode: boolean,
): Promise<string | null> {
  if (!allInputs.length) return null;

  const projectPath = extractProjectPath(allInputs);
  const messagesText = allInputs.map((m, i) => `${i + 1}. ${m}`).join('\n');

  const prompt =
    isUpdateMode && existingDescription
      ? `Update the project group description for "${groupName}" based on new session data.

Current description:
"${existingDescription}"

Recent user messages from sessions in this group:
${messagesText}

Update the description to incorporate any new findings. Keep the same 3-4 sentence structure answering in order:
1. Where is the project root? (Quote the exact absolute path verbatim when present.)
2. What is the purpose of this project?
3. What is the primary programming language?

Rules: single paragraph, under ~500 characters, no markdown, no bullet points, no newlines. Preserve correct existing information. Only change what the messages provide new or better details on.

Respond with ONLY valid JSON: {"groupDescription":"..."}`
      : `Generate a description for the project group "${groupName}" based on these session messages.

Messages:
${messagesText}

Write a SINGLE paragraph of 3-4 sentences (no markdown, no bullet points, no newlines) answering in order:
1. Where is the project root? (Quote the exact absolute path verbatim when present, or say so if absent.)
2. What is the purpose of this project?
3. What is the primary programming language? (Name it when inferable; "Primary language not identified." if not.)

Keep the whole description under ~500 characters.

Respond with ONLY valid JSON: {"groupDescription":"..."}`;

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

    const raw = stripResponseWrappers(result.content);

    const parsed: unknown = JSON.parse(raw);
    const response = z.object({ groupDescription: z.string() }).parse(parsed);

    let description = response.groupDescription
      .trim()
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (projectPath && !description.includes(projectPath)) {
      description = `Project root: ${projectPath}. ${description}`.trim();
    }

    return description.slice(0, 800);
  } catch (err) {
    logger.warn('Group description enrichment failed', { groupName, error: err });
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

    // Step 1: classify to determine the group name and an initial description
    const result = await classifyGroup(inputs, existingGroups);
    if (!result) return;

    // Step 2: if the session was matched to an existing group, fetch sibling
    // inputs to enrich the description with broader project context.
    const isExistingGroup = existingGroups.some(
      (g) => g.groupName.toLowerCase() === result.groupName.toLowerCase(),
    );

    let finalDescription = result.groupDescription;

    if (isExistingGroup) {
      const siblingInputs = await fetchSiblingInputs(subscriptionId, result.groupName, sessionId);
      if (siblingInputs.length > 0) {
        // Combine current session inputs with recent sibling inputs (cap at 18).
        const combinedInputs = [...inputs, ...siblingInputs].slice(0, 18);
        const enriched = await enrichGroupDescription(
          result.groupName,
          combinedInputs,
          result.groupDescription,
          true,
        );
        if (enriched) finalDescription = enriched;
      }
    }

    await AgentSession.update(
      { groupName: result.groupName, groupDescription: finalDescription },
      { where: { id: sessionId } },
    );

    logger.info('Session group updated', { sessionId, groupName: result.groupName });
  } catch (err) {
    logger.error('Failed to update session group', { sessionId, error: err });
  }
}

// ---------------------------------------------------------------------------
// Cron helper: refresh the description for one group by collecting the most
// recent 10 user inputs across all sessions in that group and asking the LLM
// to UPDATE the existing description with any new findings.
// ---------------------------------------------------------------------------

async function refreshGroupDescription(
  subscriptionId: string,
  groupName: string,
  existingDescription: string | null,
): Promise<void> {
  try {
    const sessions = await AgentSession.findAll({
      where: { subscriptionId, groupName },
      order: [['last_active_at', 'DESC']],
      limit: 15,
      attributes: ['historyJson'],
    });

    const allInputs: string[] = [];
    for (const s of sessions) {
      for (const inp of extractUserInputs(s.historyJson)) {
        allInputs.push(inp);
        if (allInputs.length >= 10) break;
      }
      if (allInputs.length >= 10) break;
    }

    if (!allInputs.length) return;

    const newDescription = await enrichGroupDescription(
      groupName,
      allInputs,
      existingDescription,
      true,
    );

    if (!newDescription) return;

    // Sync the updated description to every session in this group.
    await AgentSession.update(
      { groupDescription: newDescription },
      { where: { subscriptionId, groupName } },
    );

    logger.info('Group description refreshed', { subscriptionId, groupName });
  } catch (err) {
    logger.error('Failed to refresh group description', { subscriptionId, groupName, error: err });
  }
}

// ---------------------------------------------------------------------------
// Public: refresh all sessions for a subscription (used by cron)
// ---------------------------------------------------------------------------

export async function refreshAllSessionGroups(subscriptionId: string): Promise<void> {
  try {
    // Refresh descriptions for all existing groups (one LLM call per group).
    const groupRows = await AgentSession.findAll({
      where: {
        subscriptionId,
        groupName: { [Op.not]: null },
      },
      attributes: ['groupName', 'groupDescription'],
      group: ['group_name'],
    });

    logger.info('Refreshing session groups', {
      subscriptionId,
      groupCount: groupRows.length,
    });

    for (const row of groupRows) {
      await refreshGroupDescription(subscriptionId, row.groupName!, row.groupDescription ?? null);
    }

    // Also classify any sessions that haven't been grouped yet.
    const ungroupedSessions = await AgentSession.findAll({
      where: { subscriptionId, groupName: null },
      order: [['last_active_at', 'DESC']],
      limit: 20,
      attributes: ['id'],
    });

    for (const session of ungroupedSessions) {
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
  const ONE_HOUR_MS = 60 * 60 * 1_000;

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

  setInterval(() => void tick(), ONE_HOUR_MS);
  logger.info('Session grouping cron started (1h interval)');

  // If no session has a group yet (e.g. first startup after the feature was
  // added, or a fresh self-hosted install with existing sessions), run the
  // full backfill immediately rather than waiting 1 hours.
  void (async () => {
    try {
      const ungrouped = await AgentSession.count({ where: { groupName: null } });
      const grouped = await AgentSession.count({ where: { groupName: { [Op.not]: null } } });
      logger.info(
        `Session grouping backfill check: ${ungrouped} ungrouped sessions, ${grouped} grouped sessions`,
      );
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
