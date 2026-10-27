import type { Logger } from 'winston';
import type { SessionState } from '../types';
import type { AIMessage } from '../../ai-client';
import { isInjectedUserPrompt } from '../injectedUserPrompts';

function isTaskContext(message: AIMessage): boolean {
  if (message.role === 'system') return true;
  if (message.role !== 'user') return false;
  return (
    !/^(TERMINAL OUTPUT|COMMAND ERROR):/i.test(message.content.trim()) &&
    !isInjectedUserPrompt(message.content)
  );
}

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
    if (isTaskContext(history[i])) continue;
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

  // Remove one old assistant/tool exchange at a time. User requirements,
  // project context, stored instructions and compact memory are never eviction
  // candidates, even when the latest message is just "continue" or "push it".
  // Keep the latest response/tool exchange available for the next model call.
  let latestResponse = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      latestResponse = i;
      break;
    }
  }
  const start = history.findIndex(
    (message, index) => index < latestResponse && !isTaskContext(message),
  );
  if (start < 0) return false;

  let end = start + 1;
  if (history[start].role === 'assistant' && history[start].tool_calls?.length) {
    // A tool-call message and all of its results must leave together.
    while (end < history.length && history[end].role === 'tool') end++;
  } else if (history[start].role === 'tool') {
    while (end < history.length && history[end].role === 'tool') end++;
  }
  const removed = history.splice(start, end - start);
  log.warn('Dropped oldest history exchange after context-length error', {
    removedCount: removed.length,
    removedRoles: removed.map((message) => message.role),
    historyLength: history.length,
  });
  return true;
}
