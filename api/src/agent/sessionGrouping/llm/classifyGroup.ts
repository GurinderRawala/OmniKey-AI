import { z } from 'zod';
import { aiClient, getDefaultModel } from '../../../ai-client';
import { config } from '../../../config';
import { logger } from '../../../logger';
import {
  extractProjectPath,
  extractStoredProjectPath,
  findGroupByExactPath,
  stripResponseWrappers,
} from '../utils';

const aiModel = getDefaultModel(config.aiProvider, 'fast');

/**
 * classifyGroup picks ONLY the group NAME for a session. Group descriptions
 * are intentionally NOT produced here — that responsibility belongs to the
 * cron's `generateGroupDescriptionFromSummaries`, which rolls settled
 * per-session summaries up into a group-level description.
 *
 * Why the split: the first turn of a new session is the worst possible
 * moment to write a description that is supposed to describe the whole
 * project. The LLM sees one task in isolation and would shape the
 * description around it; that description then survives into the
 * `<project_context>` of every future session in the group.
 */
export interface GroupResult {
  groupName: string;
}

export async function classifyGroup(
  userInputs: string[],
  existingGroups: Array<{ groupName: string; groupDescription: string | null }>,
): Promise<GroupResult | null> {
  if (!userInputs.length) return null;

  // Deterministically extract the project path from the current session.
  // This is the single most reliable signal we have — far more reliable
  // than the LLM's interpretation — so we use it both to short-circuit
  // and to anchor the LLM's reasoning.
  const currentPath = extractProjectPath(userInputs);

  // 1) Path-first short-circuit. If any existing group already has the
  //    EXACT same stored project root, that is the group. Skip the LLM
  //    entirely — no name to invent, no chance of mis-matching to a parent
  //    repo.
  if (currentPath) {
    const exactMatch = findGroupByExactPath(currentPath, existingGroups);
    if (exactMatch) {
      logger.info('Session group matched by exact project path', {
        groupName: exactMatch.groupName,
        path: currentPath,
      });
      return { groupName: exactMatch.groupName };
    }
  }

  // 2) Build the existing-groups list for the LLM, INCLUDING each group's
  //    stored project root path when we can recover it. Without this the
  //    LLM only sees group NAMES and has no way to disambiguate two
  //    projects that happen to share a generic name (e.g. "CLI") or to
  //    avoid re-using the parent repo's name when the user has moved on
  //    to a child project.
  const existingText = existingGroups.length
    ? existingGroups
        .map((g) => {
          const storedPath = extractStoredProjectPath(g.groupDescription);
          return storedPath
            ? `- "${g.groupName}" (root: ${storedPath})`
            : `- "${g.groupName}" (root: unknown)`;
        })
        .join('\n')
    : 'None.';

  const currentPathLine = currentPath
    ? `Project root detected in messages: ${currentPath}`
    : 'No absolute project path was detected in the messages.';

  const prompt = `Analyze these chat messages and assign a project group.

Messages:
${userInputs.map((m, i) => `${i + 1}. ${m}`).join('\n')}

${currentPathLine}

Existing groups (each shown with its stored project root):
${existingText}

Rules for the group name (in priority order):
1. If "Project root detected in messages" above is non-empty AND it is an
   EXACT match for an existing group's stored root, return that existing
   group's EXACT name verbatim. Do not modify the casing or punctuation.
2. If "Project root detected in messages" is a STRICT ANCESTOR or
   DESCENDANT of an existing group's stored root (e.g. detected is
   /Users/me/Repo/cli and an existing group's root is /Users/me/Repo), they
   are DIFFERENT projects — create a new group name for the detected path.
   Do NOT re-use the ancestor or descendant group's name.
3. If no path is detected but an existing group's NAME clearly matches the
   subject of the messages, return that existing name.
4. Otherwise create a concise NEW group name: 2-4 words, Title Case, derived
   from the deepest meaningful path segment (e.g. /Users/john/projects/my-app
   → "My App") or from the topic when no path is present.
5. If the session is purely general/conversational with no project signal,
   use "General".

You ONLY need to produce a group NAME here. Do NOT write a description —
the cron job builds the group's description from per-session summaries
after sessions end. Anything you put outside the requested JSON will be
discarded.

Respond with ONLY valid JSON, no markdown:
{"groupName":"..."}`;

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
    const response = z.object({ groupName: z.string() }).parse(parsed);
    let groupName = response.groupName.trim().slice(0, 100);
    if (!groupName) return null;

    // Validate the LLM-chosen existing group, if any, against project paths.
    // The LLM's name-based pick may be wrong — it might re-use a parent
    // project's name even when the user is in a child project, or vice
    // versa.
    let existingMatch = existingGroups.find(
      (g) => g.groupName.toLowerCase() === groupName.toLowerCase(),
    );

    if (existingMatch && currentPath) {
      const storedPath = extractStoredProjectPath(existingMatch.groupDescription);
      if (storedPath && storedPath !== currentPath) {
        logger.info('Rejecting LLM existing-group match: project paths differ', {
          groupName,
          storedPath,
          currentPath,
        });
        existingMatch = undefined;
        // Derive a sensible new name from the current path instead of
        // re-using the LLM's name (which is already taken by the other
        // project). Title-case the last segment.
        const segs = currentPath.split('/').filter(Boolean);
        const last = segs[segs.length - 1] ?? groupName;
        const derived = last
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim()
          .slice(0, 100);
        if (derived) groupName = derived;
      }
    }

    // If the LLM matched an existing group AND the path check did not
    // reject it, return the canonical existing name verbatim so we don't
    // fragment groups by re-casing or re-punctuating the name.
    if (existingMatch) {
      return { groupName: existingMatch.groupName };
    }

    // Final safety net: if currentPath EXACTLY matches some other existing
    // group's stored path (different name than the LLM picked), prefer that
    // group. The LLM is allowed to invent a name, but path equality is
    // ground truth.
    if (currentPath) {
      const pathMatch = findGroupByExactPath(currentPath, existingGroups);
      if (pathMatch && pathMatch.groupName.toLowerCase() !== groupName.toLowerCase()) {
        logger.info('Overriding LLM group choice with exact-path match', {
          llmGroup: groupName,
          matchedGroup: pathMatch.groupName,
          path: currentPath,
        });
        return { groupName: pathMatch.groupName };
      }
    }

    return { groupName };
  } catch (err) {
    logger.warn('Session group classification failed', { error: err });
    return null;
  }
}
