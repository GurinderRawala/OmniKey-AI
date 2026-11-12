import type { AIMessage } from '../../ai-client';

/**
 * Request copy without OmniKey-only presentation metadata (`session_diff`).
 * Provider adapters map explicit fields today; this keeps snapshot metadata
 * out of every provider request even if an adapter ever forwards raw messages.
 */
export function stripProviderMetadata(messages: AIMessage[]): AIMessage[] {
  if (!messages.some((m) => m.session_diff !== undefined)) return messages;
  return messages.map((m) => {
    if (m.session_diff === undefined) return m;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { session_diff, ...rest } = m;
    return rest;
  });
}
