import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../web-search/web-search-provider';
import {
  AIMessage,
  AITool,
  getMaxMessageContentLength,
  providerSupportsImageGeneration,
} from '../ai-client';
import { AgentSendFn, SessionState } from './types';
import { config } from '../config';
import { Logger } from 'winston';
import { IMAGE_GENERATE_TOOL } from './imageTool';

/**
 * Tool definition for shell script execution. Registered as a native function
 * tool for all providers (including gpt-5.5 via the Responses API) so the
 * model invokes it via function calling rather than emitting XML tags.
 * agentServer intercepts the call, forwards the script to the frontend,
 * and resolves the tool result with the terminal output.
 */
export const SHELL_SCRIPT_TOOL: AITool = {
  name: 'shell_script',
  description:
    "Execute a shell script on the user's machine. The terminal output is returned to you automatically as the tool result. Use this for any machine, file, process, network, or environment operation.",
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'The shell script to execute on the user\'s machine.',
      },
    },
    required: ['script'],
  },
};

/**
 * Limited variant of the shell tool used when the user has set
 * `TERMINAL_ACCESS=limited` in `~/.omnikey/config.json` (Settings → Agent Access).
 * The functional surface area is identical (the script still runs on the user's
 * machine through the same WebSocket pipeline), but the description tells the
 * model to stay within read-only / inspection commands and never perform
 * destructive or system-altering operations. This is a soft, prompt-level
 * restriction — there is no kernel-level sandbox — but it is the same model
 * the rest of the agent uses to scope behaviour (system prompt + tool
 * description).
 */
export const SHELL_SCRIPT_TOOL_LIMITED: AITool = {
  name: 'shell_script',
  description:
    "Execute a READ-ONLY shell script on the user's machine. Terminal access is set to LIMITED — the script must only inspect state (ls, cat, grep, ps, env, which, stat, head, tail, df, du, uname, echo, printenv, etc.) and MUST NOT modify the filesystem, install packages, change configuration, kill processes, write/delete files, or make outbound mutating network calls. If a task requires mutation, respond with <final_answer> explaining that terminal access is limited and ask the user to enable full access in Settings.",
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          "Read-only shell script. Restrict yourself to inspection commands; do not write, delete, install, configure, or otherwise mutate state.",
      },
    },
    required: ['script'],
  },
};

/**
 * Returns the set of web tools available to the agent for every turn.
 *
 * `web_search` is always included because DuckDuckGo is used as a free
 * fallback when no third-party search key is configured.
 *
 * `generate_image` is omitted for providers without image-generation
 * support (currently Anthropic and Nemotron) because the underlying
 * `aiClient.generateImage()` only supports OpenAI and Gemini — registering
 * an unsupported tool would invite the model to call it and fail at
 * execution time. The system prompt for those providers is built without
 * the image-tool section to match this tool set.
 *
 * @returns An array of `AITool` definitions ready to pass to the AI client.
 */
export function buildAvailableTools(extraTools: AITool[] = []): AITool[] {
  // Web tools are registered only when the user has not opted out via the
  // Settings UI (WEB_SEARCH_ENABLED in ~/.omnikey/config.json). Removing the
  // tool definitions outright — rather than keeping them and refusing at the
  // dispatch layer — keeps the model from being tempted to call them and
  // matches how MCP-only tools are gated elsewhere in the agent.
  const baseTools: AITool[] = config.webSearchEnabled
    ? [WEB_FETCH_TOOL, WEB_SEARCH_TOOL]
    : [];
  if (providerSupportsImageGeneration(config.aiProvider)) {
    baseTools.push(IMAGE_GENERATE_TOOL);
  }
  return [...baseTools, ...extraTools];
}

/**
 * Strips the `@omniagent` mention from user-supplied content.
 *
 * The desktop client prefixes messages with `@omniAgent` to trigger the agent.
 * This helper removes that prefix (case-insensitive) so the raw directive
 * reaches the model without the routing annotation.
 *
 * @param content - Raw content string from the client message.
 * @param hasStoredPrompt - only remove the mention if the command has a stored prompt, otherwise it may be part of the user input
 * @returns The cleaned content string with the mention removed and whitespace trimmed.
 */
export function createUserContent(content: string, hasStoredPrompt: boolean): string {
  if (hasStoredPrompt) {
    return content.replace(/@omniagent/gi, '').trim();
  }
  return content;
}

/**
 *
 * If it is a cron job and the prompt does not contain an @omniAgent mention, we will add it, since we will not consider any base prompt.
 */
export function createUserContentForCronJob(content: string): string {
  if (!/@omniagent/gi.test(content)) {
    return `@omniAgent ${content}`;
  }
  return content.trim();
}

/**
 * Sends a `<final_answer>` message over the WebSocket and closes the agent turn.
 *
 * Wraps `message` in `<final_answer>` tags so the client knows the agent has
 * finished reasoning and can display the result. Used for both successful
 * conclusions and error responses.
 *
 * @param send - The WebSocket send function scoped to the current connection.
 * @param sessionId - ID of the session this answer belongs to.
 * @param message - The final answer text to send to the client.
 * @param isError - When `true`, the client renders the message as an error.
 */
export function sendFinalAnswer(
  send: AgentSendFn,
  sessionId: string,
  message: string,
  isError: boolean,
): void {
  send({
    session_id: sessionId,
    sender: 'agent',
    content: `<final_answer>\n${message}\n</final_answer>`,
    is_terminal_output: false,
    is_error: isError,
  });
}

// Per-message hard string limit enforced by the provider API.
const MAX_MESSAGE_CONTENT = getMaxMessageContentLength(config.aiProvider);
// Head/tail chars kept when a single message exceeds the per-message cap.
const OVER_CAP_HEAD_RATIO = 0.6;

/**
 * Pushes a message onto the session history.
 *
 * The only limit enforced here is the provider's **per-message** hard cap
 * (`MAX_MESSAGE_CONTENT` — e.g. Anthropic's ~10 MB per content string). A single
 * message larger than that is compacted in the middle (keeping a head and tail)
 * so the request is still accepted while retaining the most useful context.
 *
 * Fitting the *whole* history inside the model's context window is deliberately
 * NOT done here. `completeWithContextRecovery` proactively trims the oldest
 * turns — and reactively prunes/compacts on an over-window error — before every
 * send. That keeps the newest turn (the current task) intact and lets the agent
 * keep working. The previous behaviour truncated the *latest* message and
 * injected a "stop and give a final answer" directive, which made the agent
 * abandon the task even after recovery had freed up room; that is intentionally
 * gone.
 */
export function pushToSessionHistory(
  logger: Logger,
  session: SessionState,
  message: AIMessage,
): void {
  if (typeof message.content !== 'string') {
    session.history.push(message);
    return;
  }

  let content = message.content;

  // Per-message content cap. Compact the middle rather than dropping the tail so
  // a huge single message keeps a useful head and tail. This is a safety net
  // only — terminal output is already bounded upstream by truncateTerminalOutput.
  if (content.length > MAX_MESSAGE_CONTENT) {
    const head = Math.floor(MAX_MESSAGE_CONTENT * OVER_CAP_HEAD_RATIO);
    const tail = Math.max(0, MAX_MESSAGE_CONTENT - head - 200);
    const dropped = content.length - head - tail;
    content =
      content.slice(0, head) +
      `\n\n[... ${dropped.toLocaleString()} chars omitted (message exceeded the per-message size limit) ...]\n\n` +
      content.slice(content.length - tail);
    logger.warn(
      `Single message exceeded per-message cap; compacted from ${message.content.length} to ${content.length} chars.`,
    );
  }

  // Always push messages that carry function-call data even when their text
  // content is empty (e.g. Responses API assistant messages whose only output
  // is a function_call item). Skipping them leaves an orphaned
  // function_call_output on the next turn, which the API rejects with
  // "No tool call found for function call output with call_id ...".
  const hasFunctionData =
    (message.tool_calls?.length ?? 0) > 0 || message.role === 'tool';
  if (content.length > 0 || hasFunctionData) {
    session.history.push({ ...message, content });
  }
}

// ─── Context-window overflow recovery ─────────────────────────────────────────
//
// The char budget enforced above is only an *estimate* (2 chars/token against a
// configured 1M window). The provider's real token count can still overflow the
// deployed model's actual context window — for example when a single message
// carries a big pasted blob, when content tokenizes denser than 2 chars/token
// (JSON, code, tool results), or when the configured window is larger than the
// model actually supports. When that happens `aiClient.complete` throws a
// context-length error. The helpers below let the caller recover in place —
// shrink the history and retry — instead of killing the whole session.

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
 * message. Kept deliberately broad — a false positive just triggers a harmless
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
 * Shrinks a session's history *in place* so a retried completion fits inside the
 * model's real context window. Call it after a provider rejects a turn with a
 * context-length error, then retry `aiClient.complete`.
 *
 * Two strategies, applied in order, one step per call so the caller can retry in
 * a loop and stop as soon as the request fits:
 *
 *   1. **Compact the single largest oversized message** — replace its middle
 *      with a truncation notice, keeping a head and tail. This targets the
 *      "one big pasted message blew up the window" case without reordering
 *      messages or disturbing tool_call/tool_result pairing.
 *   2. **Drop the oldest droppable unit** — a user turn, a plain assistant turn,
 *      or an assistant `tool_calls` message together with its following tool
 *      results as one atomic block (so a tool_call is never left without its
 *      results, which the provider APIs reject). Leading system messages and the
 *      final user turn are always preserved.
 *
 * @returns true if the history changed (caller should retry), false if there is
 *          nothing left to prune.
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
    // Only system messages and the final user turn remain — nothing droppable
    // without breaking the request. The caller should surface the error.
    log.warn('Cannot prune history further for context-length recovery', {
      historyLength: history.length,
      systemEnd,
      protectedStart,
    });
    return false;
  }

  // The oldest unit begins right after the system messages. An assistant message
  // that carries tool_calls owns the tool-result messages that immediately
  // follow it — drop them together so we never orphan a tool_call or a result.
  let unitEnd = systemEnd + 1;
  if (
    history[systemEnd].role === 'assistant' &&
    (history[systemEnd].tool_calls?.length ?? 0) > 0
  ) {
    while (unitEnd < history.length && history[unitEnd].role === 'tool') unitEnd++;
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
