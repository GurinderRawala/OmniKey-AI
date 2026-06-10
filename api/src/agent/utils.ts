import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../web-search/web-search-provider';
import {
  AIMessage,
  AITool,
  getMaxMessageContentLength,
  getMaxHistoryLength,
  providerSupportsImageGeneration,
} from '../ai-client';
import { AgentSendFn, SessionState } from './types';
import { config } from '../config';
import { Logger } from 'winston';
import { IMAGE_GENERATE_TOOL } from './imageTool';

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
  const baseTools: AITool[] = [WEB_FETCH_TOOL, WEB_SEARCH_TOOL];
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
// Total character budget across all history messages (derived from the
// provider's context-window size minus headroom for output + system prompt).
export const MAX_HISTORY_TOTAL = getMaxHistoryLength(config.aiProvider);

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
  const currentTotal = session.history.reduce((acc, msg) => {
    if (typeof msg.content === 'string') return acc + msg.content.length;
    if (msg.content != null) return acc + JSON.stringify(msg.content).length;
    return acc;
  }, 0);
  const remaining = MAX_HISTORY_TOTAL - currentTotal;
  if (content.length > remaining) {
    // Truncate to whatever space is left, but never to a zero-length string —
    // empty messages break the Responses API and confuse other models. If there
    // is no room at all, skip the message entirely and just inject the
    // final-answer prompt.
    const trimmed = Math.max(0, remaining);
    content = trimmed > 0 ? content.slice(0, trimmed) : '';
    limitHit = true;
  }

  if (content.length > 0) {
    session.history.push({ ...message, content });
  }

  if (limitHit) {
    // Avoid pushing duplicate final-answer prompts when successive messages
    // are all being dropped (remaining has been 0 for several turns).
    const lastMsg = session.history[session.history.length - 1];
    if (lastMsg?.content !== FINAL_ANSWER_REQUEST.content) {
      logger.warn(
        `History limits exceeded. Message truncated to ${content.length} chars, total history is now ${currentTotal + content.length} chars.`,
      );
      session.history.push(FINAL_ANSWER_REQUEST);
    }
  }
}
