/**
 * sessionGrouping.ts holds the four public entry points that the rest of
 * the app calls:
 *
 *   - updateSessionGroup(sessionId, subscriptionId)
 *     Called by the agent server when a session sends its first turn and
 *     has no group yet. Picks a group NAME via classifyGroup, attaches
 *     the session to that group, and stops. No description work, no
 *     summary work.
 *
 *   - summariseSession(sessionId, subscriptionId)
 *     Called by the agent server's WebSocket close handler. Generates
 *     a fresh sessionSummary from the just-finished session.
 *
 *   - buildProjectContext(subId, groupName, currentInputs, excludeSessionId)
 *     Called by the agent server before every user turn. Assembles the
 *     <project_context> block from the group's stored description + the
 *     last 5 sibling session summaries + a confidence signal.
 *
 *   - refreshAllSessionGroups / startGroupingCronJob (re-exported from
 *     ./cron) — the hourly cron job entry points.
 *
 * The heavy lifting (LLM prompts, path normalisation, etc.) lives in
 * ./llm and ./utils. This file is the orchestration layer only.
 */
import { Op } from 'sequelize';
import { AgentSession } from '../../models/agentSession';
import { logger } from '../../logger';
import { classifyGroup, generateSessionSummary } from './llm';
import {
  extractProjectPath,
  extractStoredProjectPath,
  extractUserInputs,
  formatSessionTimestamp,
  pathsRelated,
} from './utils';

// ---------------------------------------------------------------------------
// buildProjectContext — assembles the <project_context> block injected
// into every user turn for an already-grouped session.
// ---------------------------------------------------------------------------

export type ProjectContextConfidence = 'high' | 'medium' | 'low';

export interface BuildProjectContextResult {
  text: string;
  workingDirectory: string | null;
  confidence: ProjectContextConfidence;
  groupDescriptionUpdatedAt: Date | null;
}

/**
 * Assemble the `<project_context>` block. The block contains:
 *
 *   <project_context name="...">
 *   Working directory: /Users/me/MyApp
 *   Confidence: high | medium | low
 *   [purpose + primary language meta]
 *   Group description last updated: 2026-06-12 22:38 UTC
 *   Recent sessions in this project (most recent first):
 *   - 2026-06-12 17:37 UTC — ...
 *   ...
 *   </project_context>
 *
 * Working directory + confidence come from the group's stored project
 * root matched against the CURRENT session's deterministic root
 * extraction. Confidence:
 *   high   — group's stored path exactly matches the path the user is
 *            currently typing about, or no fresh path was detected (so
 *            we trust the stored one);
 *   medium — current path is an ancestor or descendant of the stored
 *            path (same project, different reference depth — the LLM
 *            should confirm before assuming);
 *   low    — current path is disjoint from the stored path, or no
 *            working directory could be determined at all.
 */
export async function buildProjectContext(
  subscriptionId: string,
  groupName: string,
  currentSessionInputs: string[] | null,
  excludeSessionId?: string,
): Promise<BuildProjectContextResult | null> {
  // Fetch the group's most recent description-bearing row.
  const groupRow = await AgentSession.findOne({
    where: {
      subscriptionId,
      groupName,
      groupDescription: { [Op.not]: null },
    },
    attributes: ['groupName', 'groupDescription', 'groupDescriptionUpdatedAt'],
    order: [['last_active_at', 'DESC']],
  });
  if (!groupRow?.groupDescription) return null;

  const storedPath = extractStoredProjectPath(groupRow.groupDescription);
  const currentPath =
    currentSessionInputs && currentSessionInputs.length
      ? extractProjectPath(currentSessionInputs)
      : null;

  let confidence: ProjectContextConfidence;
  if (!currentPath) {
    // No fresh signal from this turn → trust the stored path (if any).
    confidence = storedPath ? 'high' : 'low';
  } else if (!storedPath) {
    confidence = 'low';
  } else if (storedPath === currentPath) {
    confidence = 'high';
  } else if (pathsRelated(storedPath, currentPath)) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Recent sibling summaries. Filter out the current session so the agent
  // doesn't see its own (probably still-empty) summary as "recent
  // activity".
  const siblingWhere: Record<string, unknown> = {
    subscriptionId,
    groupName,
    sessionSummary: { [Op.not]: null },
  };
  if (excludeSessionId) siblingWhere.id = { [Op.ne]: excludeSessionId };

  const recentSessions = await AgentSession.findAll({
    where: siblingWhere,
    order: [['last_active_at', 'DESC']],
    limit: 5,
    attributes: ['sessionSummary', 'lastActiveAt'],
  });

  // Trim the group-level description down to just the project-meta parts
  // (purpose + primary language). The deterministic shape we now write
  // is "Project root: ... . Purpose: ... . Primary language: ..." so we
  // drop the leading "Project root: ..." sentence and keep the rest.
  const projectMeta = groupRow.groupDescription.replace(/^Project root:\s*\S+\.\s*/i, '').trim();

  const lines: string[] = [];
  lines.push(`<project_context name="${groupRow.groupName}">`);
  if (storedPath || currentPath) {
    lines.push(`Working directory: ${currentPath ?? storedPath ?? '(unknown)'}`);
  } else {
    lines.push('Working directory: (not yet known)');
  }
  lines.push(
    `Confidence: ${confidence}` +
      (confidence === 'high'
        ? ''
        : ' (the path above may not be where this turn applies — confirm before running file operations)'),
  );
  if (projectMeta) {
    lines.push('');
    lines.push(projectMeta);
  }
  // Always surface how fresh the project meta is, so the agent can decide
  // whether to trust it vs. re-confirm from the messages.
  const descUpdatedAt = groupRow.groupDescriptionUpdatedAt ?? null;
  lines.push('');
  lines.push(
    `Group description last updated: ${descUpdatedAt ? formatSessionTimestamp(descUpdatedAt) : '(unknown — predates this feature; will be refreshed on the next cron tick)'}`,
  );
  if (recentSessions.length > 0) {
    lines.push('');
    lines.push(`Recent sessions in this project (most recent first):`);
    for (const s of recentSessions) {
      const ts = formatSessionTimestamp(s.lastActiveAt);
      const summary = (s.sessionSummary ?? '').trim();
      if (summary) lines.push(`- ${ts} — ${summary}`);
    }
  }
  lines.push('</project_context>');

  return {
    text: lines.join('\n'),
    workingDirectory: currentPath ?? storedPath,
    confidence,
    groupDescriptionUpdatedAt: descUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// summariseSession — (re)generate the per-session summary for a single
// session. Called by the agent server when a session ends.
// ---------------------------------------------------------------------------

/**
 * (Re)generate the per-session summary for a single session. The summary
 * is the unit of "recent activity" surfaced in future turns'
 * `<project_context>` block — by refreshing it on session-end rather
 * than on a cron schedule, the next session in the same group sees what
 * the user JUST finished doing instead of what they were doing an hour
 * ago.
 *
 * We do not gate by an in-memory marker here because the caller already
 * knows the session has just ended; if there's nothing to summarise (no
 * real user inputs) we bail silently.
 */
export async function summariseSession(sessionId: string, subscriptionId: string): Promise<void> {
  try {
    const session = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId },
      attributes: ['id', 'historyJson'],
    });
    if (!session) return;

    const inputs = extractUserInputs(session.historyJson);
    if (!inputs.length) return;

    const summary = await generateSessionSummary(inputs);
    if (!summary) return;

    await AgentSession.update({ sessionSummary: summary }, { where: { id: sessionId } });

    logger.info('Session summary generated on session end', { sessionId });
  } catch (err) {
    logger.warn('Failed to generate session summary on session end', { sessionId, error: err });
  }
}

// ---------------------------------------------------------------------------
// updateSessionGroup — pick a group name for a session and attach the
// session to it. Called by the agent server when a session sends its
// first turn and has no group yet.
// ---------------------------------------------------------------------------

/**
 * Pick a group name for a session and attach the session to it. Does NO
 * description work and NO summary work:
 *   - Group descriptions are produced by the cron from settled per-session
 *     summaries (see refreshGroupDescription).
 *   - Per-session summaries are produced when the session ENDS (see
 *     summariseSession, fired from the agent server's WebSocket close
 *     handler).
 *
 * Doing description work here used to mean the very first turn of a new
 * session got to shape the group's description around a single task; that
 * drift is what this layering fixes.
 */
export async function updateSessionGroup(sessionId: string, subscriptionId: string): Promise<void> {
  try {
    const session = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId },
      attributes: ['id', 'historyJson'],
    });
    if (!session) return;

    const inputs = extractUserInputs(session.historyJson);
    if (!inputs.length) return;

    // Fetch existing distinct groups (by name) to encourage reuse.
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

    const isExistingGroup = existingGroups.some(
      (g) => g.groupName.toLowerCase() === result.groupName.toLowerCase(),
    );

    await AgentSession.update({ groupName: result.groupName }, { where: { id: sessionId } });

    logger.info('Session group updated', {
      sessionId,
      groupName: result.groupName,
      isExistingGroup,
    });
  } catch (err) {
    logger.error('Failed to update session group', { sessionId, error: err });
  }
}
