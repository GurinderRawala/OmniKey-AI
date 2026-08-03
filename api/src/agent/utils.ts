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
import type { AgentSettingsSnapshot } from '../agentSettingsStore';

export { isContextLengthError, pruneHistoryForContextLimit } from './agentServer/contextPruning';

/**
 * Tool definition for shell script execution. Registered as a native function
 * tool for all providers (including GPT-5 via the Responses API) so the
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
        description: "The shell script to execute on the user's machine.",
      },
      filter_keywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional keywords, filenames, test names, IDs, or error codes that should be prioritized when refining verbose terminal output before it is returned as the tool result.',
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
          'Read-only shell script. Restrict yourself to inspection commands; do not write, delete, install, configure, or otherwise mutate state.',
      },
      filter_keywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional keywords, filenames, test names, IDs, or error codes that should be prioritized when refining verbose terminal output before it is returned as the tool result.',
      },
    },
    required: ['script'],
  },
};

/**
 * Returns the set of web tools available to the agent for every turn.
 *
 * Web tools are included when the current DB-backed Agent Access settings
 * allow them.
 *
 * `generate_image` is omitted for providers without image-generation
 * support (currently Anthropic and the OpenAI-compatible open-model path) because the underlying
 * `aiClient.generateImage()` only supports OpenAI and Gemini — registering
 * an unsupported tool would invite the model to call it and fail at
 * execution time. The system prompt for those providers is built without
 * the image-tool section to match this tool set.
 *
 * @returns An array of `AITool` definitions ready to pass to the AI client.
 */
export function buildAvailableTools(
  settings: Pick<AgentSettingsSnapshot, 'webSearchEnabled'>,
  extraTools: AITool[] = [],
): AITool[] {
  // Web tools are registered only when the user has not opted out via the
  // Settings UI. Removing the
  // tool definitions outright — rather than keeping them and refusing at the
  // dispatch layer — keeps the model from being tempted to call them and
  // matches how MCP-only tools are gated elsewhere in the agent.
  const baseTools: AITool[] = settings.webSearchEnabled ? [WEB_FETCH_TOOL, WEB_SEARCH_TOOL] : [];
  if (providerSupportsImageGeneration(config.aiProvider)) {
    baseTools.push(IMAGE_GENERATE_TOOL);
  }
  return [...baseTools, ...extraTools].sort((a, b) => a.name.localeCompare(b.name));
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

// Head/tail chars kept when a single message exceeds the per-message cap.
const OVER_CAP_HEAD_RATIO = 0.6;

/**
 * Pushes a message onto the session history.
 *
 * The only limit enforced here is the provider's **per-message** hard cap
 * (e.g. Anthropic's ~10 MB per content string). A single message larger than
 * that is compacted in the middle (keeping a head and tail) so the request is
 * still accepted while retaining the most useful context.
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
  const maxMessageContent = getMaxMessageContentLength(config.aiProvider, session.activeModel);

  // Per-message content cap. Compact the middle rather than dropping the tail so
  // a huge single message keeps a useful head and tail. This is a safety net
  // only — terminal output is already bounded upstream by truncateTerminalOutput.
  if (content.length > maxMessageContent) {
    const head = Math.floor(maxMessageContent * OVER_CAP_HEAD_RATIO);
    const tail = Math.max(0, maxMessageContent - head - 200);
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
  const hasFunctionData = (message.tool_calls?.length ?? 0) > 0 || message.role === 'tool';
  if (content.length > 0 || hasFunctionData) {
    session.history.push({ ...message, content });
  }
}
