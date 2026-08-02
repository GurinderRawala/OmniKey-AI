import type { Logger } from 'winston';
import type { SessionState } from '../types';

// Head/tail chars kept when a single oversized message is compacted.
const OVERSIZED_MSG_HEAD = 4_000;
const OVERSIZED_MSG_TAIL = 4_000;
// Only compact messages large enough that compaction meaningfully shrinks them.
const OVERSIZED_MSG_THRESHOLD = OVERSIZED_MSG_HEAD + OVERSIZED_MSG_TAIL + 1_000;

/**
 * True when `err` is a provider "input exceeds the context window" style error.
 *
 * OpenAI / nemotron set `code: 'context_length_exceeded'`; Anthropic and Gemini
 * do not always expose a machine code, so we also match the human-readable
 * message. Kept deliberately broad -- a false positive just triggers a harmless
 * prune-and-retry, whereas a miss kills the session.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    error?: { code?: unknown };
    message?: unknown;
  };
  const code = String(e.code ?? e.error?.code ?? '');
  if (code === 'context_length_exceeded') return true;

  const message = String(e.message ?? '').toLowerCase();
  return (
    message.includes('context window') ||
    message.includes('context length') ||
    message.includes('maximum context') ||
    message.includes('too many tokens') ||
    message.includes('reduce the length') ||
    // Anthropic over-window error: "prompt is too long: N tokens > M maximum".
    // It carries no machine code and uses ">" rather than the word "exceed",
    // so match the phrasing directly.
    message.includes('prompt is too long') ||
    (message.includes('token') && message.includes('maximum')) ||
    (message.includes('token') && message.includes('exceed'))
  );
}

/**
 * Shrinks a session's history in place so a retried completion fits inside the
 * model's real context window. Call it after a provider rejects a turn with a
 * context-length error, then retry `aiClient.complete`.
 */
export function pruneHistoryForContextLimit(session: SessionState, log: Logger): boolean {
  const history = session.history;

  // Leading system messages are always preserved.
  let systemEnd = 0;
  while (systemEnd < history.length && history[systemEnd].role === 'system') systemEnd++;

  // Strategy 1: compact the single largest oversized message.
  let largestIdx = -1;
  let largestLen = 0;
  for (let i = systemEnd; i < history.length; i++) {
    const c = history[i].content;
    const len = typeof c === 'string' ? c.length : 0;
    if (len > largestLen) {
      largestLen = len;
      largestIdx = i;
    }
  }

  if (largestIdx >= 0 && largestLen > OVERSIZED_MSG_THRESHOLD) {
    const original = history[largestIdx].content as string;
    const dropped = original.length - OVERSIZED_MSG_HEAD - OVERSIZED_MSG_TAIL;
    history[largestIdx] = {
      ...history[largestIdx],
      content:
        original.slice(0, OVERSIZED_MSG_HEAD) +
        `\n\n[... ${dropped.toLocaleString()} chars omitted to fit the model context window ...]\n\n` +
        original.slice(original.length - OVERSIZED_MSG_TAIL),
    };
    log.warn('Compacted oversized history message after context-length error', {
      messageIndex: largestIdx,
      role: history[largestIdx].role,
      originalLength: original.length,
      newLength: (history[largestIdx].content as string).length,
    });
    return true;
  }

  // Strategy 2: drop the oldest complete unit, preserving the final user turn.
  let protectedStart = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      protectedStart = i;
      break;
    }
  }

  if (systemEnd >= protectedStart) {
    // Only system messages and the final user turn remain -- nothing droppable
    // without breaking the request. The caller should surface the error.
    log.warn('Cannot prune history further for context-length recovery', {
      historyLength: history.length,
      systemEnd,
      protectedStart,
    });
    return false;
  }

  // The oldest unit begins right after the system messages. When it starts with
  // a user message, drop that complete user -> assistant/tool exchange so the
  // retried provider history never starts with a stranded old assistant answer.
  let unitEnd = systemEnd + 1;
  if (history[systemEnd].role === 'user') {
    while (unitEnd < protectedStart && history[unitEnd].role !== 'user') unitEnd++;
  } else if (
    history[systemEnd].role === 'assistant' &&
    (history[systemEnd].tool_calls?.length ?? 0) > 0
  ) {
    while (unitEnd < history.length && history[unitEnd].role === 'tool') unitEnd++;
    if (unitEnd < protectedStart && history[unitEnd].role === 'assistant') unitEnd++;
  } else if (history[systemEnd].role === 'tool') {
    while (unitEnd < protectedStart && history[unitEnd].role === 'tool') unitEnd++;
    if (unitEnd < protectedStart && history[unitEnd].role === 'assistant') unitEnd++;
  }
  unitEnd = Math.min(unitEnd, protectedStart);

  const removed = history.splice(systemEnd, unitEnd - systemEnd);
  log.warn('Dropped oldest history unit after context-length error', {
    removedCount: removed.length,
    removedRoles: removed.map((m) => m.role),
    historyLength: history.length,
  });
  return removed.length > 0;
}
