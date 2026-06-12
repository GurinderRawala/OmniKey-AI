import { z } from 'zod';
import { aiClient, getDefaultModel } from '../../../ai-client';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { stripResponseWrappers, truncateOnSentenceBoundary } from '../utils';

const aiModel = getDefaultModel(config.aiProvider, 'fast');

/**
 * Produce a one-to-two sentence summary of what the user worked on in a
 * single session. Used to populate `AgentSession.sessionSummary`, which
 * is then pulled into the `<project_context>` block at injection time
 * so the agent always sees recent activity context WITHOUT having to
 * rewrite the group-level description on every new session.
 */
export async function generateSessionSummary(userInputs: string[]): Promise<string | null> {
  if (!userInputs.length) return null;
  const messagesText = userInputs.map((m, i) => `${i + 1}. ${m}`).join('\n');

  const prompt = `Summarise what the user worked on in this single session in 1-2 short sentences (max 240 characters total).

Messages:
${messagesText}

Rules:
- No markdown, no bullet points, no newlines, no quotes around the summary.
- Focus on the TASK the user was working on ("refactored the auth flow",
  "investigated a sqlite locking bug", "shipped a new settings pane").
- Do not include the project name or the project root path — those are
  stored separately in the group context.
- Do not include any URLs or absolute filesystem paths.
- If the session looks like exploration or general conversation with no
  concrete task, summarise the topic in one short clause.

Respond with ONLY valid JSON: {"summary":"..."}`;

  try {
    const result = await aiClient.complete(
      aiModel,
      [
        {
          role: 'system',
          content:
            'You are a session summarisation assistant. Respond only with the requested JSON object, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    );
    const raw = stripResponseWrappers(result.content);
    const parsed: unknown = JSON.parse(raw);
    const response = z.object({ summary: z.string() }).parse(parsed);
    const summary = response.summary
      .trim()
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!summary) return null;
    // Hard cap so a verbose LLM cannot blow out the context block. We aim
    // for ~240 chars but truncate on a sentence boundary up to 320.
    return truncateOnSentenceBoundary(summary, 320);
  } catch (err) {
    logger.warn('Session summary generation failed', { error: err });
    return null;
  }
}
