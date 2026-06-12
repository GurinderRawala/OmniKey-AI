import { z } from 'zod';
import { aiClient, getDefaultModel } from '../../../ai-client';
import { config } from '../../../config';
import { logger } from '../../../logger';
import {
  formatSessionTimestamp,
  stripResponseWrappers,
  truncateOnSentenceBoundary,
} from '../utils';

const aiModel = getDefaultModel(config.aiProvider, 'fast');

/**
 * Produce a fresh group description from the most recent N session
 * summaries in the group. This is the cron's only LLM call for
 * descriptions — replaces the old "enrich the group's description from
 * raw user inputs across many sessions" approach, which made the
 * description drift around whatever the latest session was about.
 *
 * The LLM sees ONLY the session summaries and the existing description;
 * it never sees raw user history. This keeps the prompt small, cheap,
 * and immune to single-session bias.
 */
export async function generateGroupDescriptionFromSummaries(
  groupName: string,
  dominantRoot: string | null,
  sessionSummaries: Array<{ summary: string; lastActiveAt: Date }>,
  existingDescription: string | null,
): Promise<string | null> {
  if (!sessionSummaries.length && !existingDescription) return null;

  const summariesBlock = sessionSummaries.length
    ? sessionSummaries
        .map((s, i) => `${i + 1}. [${formatSessionTimestamp(s.lastActiveAt)}] ${s.summary}`)
        .join('\n')
    : '(no session summaries yet)';

  const rootLine = dominantRoot
    ? `Deterministically extracted project root for this group: ${dominantRoot}\n(Use this EXACT path in the "Project root:" sentence. Do not abbreviate, do not paraphrase, do not substitute a URL for it.)`
    : 'No absolute project root could be deterministically extracted. Say "Project root: not specified." in the description.';

  const prompt = `Update the project group description for "${groupName}".

Current description:
"${existingDescription ?? '(none yet — write one from scratch)'}"

${rootLine}

Recent session summaries in this group (most recent first; each one is what the user worked on in a single session):
${summariesBlock}

A GROUP CORRESPONDS TO EXACTLY ONE PROJECT. The description must describe ONLY the project at the project root above. Do not mention any other project root. Do not invent or substitute a different absolute path.

Write the description as a SINGLE paragraph of 4-5 sentences (no markdown, no bullet points, no newlines, end on a complete sentence) answering in order:
1. Where is the project root? Use the deterministically extracted path above when provided; never use a URL.
2. What is the purpose of this project? Preserve correct information from the current description; only change what the recent summaries provide new evidence about.
3. What is the primary programming language? Name it when inferable; "Primary language not identified." otherwise.
4. What has the user been working on recently? Summarise the THEMES across the recent session summaries — do NOT enumerate sessions and do NOT restate any single session verbatim.
5. (Optional) Current focus, in one short clause.

Rules: single paragraph, under ~650 characters total. Preserve correct existing information; only refresh what the new summaries reveal.

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

    // Hard guard: replace any path the LLM wrote that disagrees with the
    // deterministic root. We do not let the LLM choose the path.
    if (dominantRoot) {
      description = description.replace(
        /Project root:\s*(\/[^\s.,;:!?)<>"'`]+)/i,
        (_m, llmPath: string) => {
          if (llmPath === dominantRoot) return `Project root: ${dominantRoot}`;
          logger.info('generateGroupDescriptionFromSummaries: replacing hallucinated path', {
            groupName,
            llmPath,
            dominantRoot,
          });
          return `Project root: ${dominantRoot}`;
        },
      );
      if (!description.includes(dominantRoot)) {
        description = `Project root: ${dominantRoot}. ${description}`.trim();
      }
    }

    return truncateOnSentenceBoundary(description, 1000);
  } catch (err) {
    logger.warn('Group description generation from summaries failed', { groupName, error: err });
    return null;
  }
}
