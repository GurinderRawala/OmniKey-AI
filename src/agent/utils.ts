import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../web-search-provider';
import { AIMessage, AITool, getMaxMessageContentLength, getMaxHistoryLength } from '../ai-client';
import { AgentSendFn, SessionState } from './types';
import { config } from '../config';
import { Logger } from 'winston';

/**
 * Returns the set of web tools available to the agent for every turn.
 *
 * `web_search` is always included because DuckDuckGo is used as a free
 * fallback when no third-party search key is configured.
 *
 * @returns An array of `AITool` definitions ready to pass to the AI client.
 */
export function buildAvailableTools(): AITool[] {
  return [WEB_FETCH_TOOL, WEB_SEARCH_TOOL];
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
// Total character budget across all history messages (derived from the
// provider's context-window size minus headroom for output + system prompt).
const MAX_HISTORY_TOTAL = getMaxHistoryLength(config.aiProvider);

const FINAL_ANSWER_REQUEST: AIMessage = {
  role: 'user',
  content:
    'Content was truncated because a length limit was reached. ' +
    'You MUST stop making tool calls and provide a final answer immediately using <final_answer>...</final_answer>.',
};

/**
 * Pushes a message onto the session history, enforcing two independent limits:
 *
 * 1. **Per-message limit** (`MAX_MESSAGE_CONTENT`) — the provider's hard cap
 *    on a single content string (e.g. Anthropic: 10 MB, OpenAI/Gemini: context-bound).
 * 2. **Total history limit** (`MAX_HISTORY_TOTAL`) — the cumulative character
 *    budget derived from each provider's context-window size.
 *
 * When either limit is hit the message content is truncated and a separate
 * `user` message is appended instructing the model to emit a final answer.
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
  let limitHit = false;

  // 1. Per-message content limit.
  if (content.length > MAX_MESSAGE_CONTENT) {
    content = content.slice(0, MAX_MESSAGE_CONTENT);
    limitHit = true;
  }

  // 2. Total history length limit.
  const currentTotal = session.history.reduce(
    (acc, msg) => acc + (typeof msg.content === 'string' ? msg.content.length : 0),
    0,
  );
  const remaining = MAX_HISTORY_TOTAL - currentTotal;
  if (content.length > remaining) {
    content = content.slice(0, Math.max(0, remaining - FINAL_ANSWER_REQUEST.content.length));
    limitHit = true;
  }

  session.history.push({ ...message, content });

  if (limitHit) {
    logger.warn(
      `History limits exceeded. Message truncated to ${content.length} chars, total history is now ${currentTotal + content.length} chars.`,
    );
    session.history.push(FINAL_ANSWER_REQUEST);
  }
}
