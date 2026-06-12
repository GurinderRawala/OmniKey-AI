import type http from 'http';
import express, { Response } from 'express';
import { Op } from 'sequelize';
import WebSocket, { WebSocketServer } from 'ws';
import cuid from 'cuid';
import { config } from '../config';
import { logger } from '../logger';
import { Subscription } from '../models/subscription';
import { SubscriptionUsage } from '../models/subscriptionUsage';
import { AgentSession } from '../models/agentSession';
import { getAgentPrompt } from './agentPrompts';
import { getPromptMcpsForSubscription } from './mcpPromptCache';
import { getMcpToolsForSubscription, executeMcpTool, MCP_TOOL_PREFIX } from './mcpRuntime';
import { getPromptForCommand } from '../featureRoutes';
import { executeTool } from '../web-search/web-search-provider';
import { createLazyAuthContext } from './agentAuth';
import { authMiddleware, AuthLocals } from '../authMiddleware';
import { executeImageGenerationTool } from './imageTool';
import {
  buildAvailableTools,
  SHELL_SCRIPT_TOOL,
  SHELL_SCRIPT_TOOL_LIMITED,
  createUserContent,
  sendFinalAnswer,
  pushToSessionHistory,
  createUserContentForCronJob,
} from './utils';
import { updateSessionGroup, buildProjectContext, summariseSession } from './sessionGrouping';
import {
  aiClient,
  AITool,
  AICompletionResult,
  getDefaultModel,
  getContextWindowSize,
  RESPONSES_API_MODEL,
} from '../ai-client';
import type { AgentMessage, AgentSendFn, SessionState } from './types';
import { Logger } from 'winston';

type TurnOutcome = 'shell_pending' | 'complete';

interface QueuedMessage {
  message: AgentMessage;
  send: AgentSendFn;
  subscription: Subscription;
  log: Logger;
}

// Per-session queuing so user messages sent during an active turn are processed
// in order after the current turn completes rather than running concurrently.
const activeSessions = new Set<string>();
const sessionQueues = new Map<string, QueuedMessage[]>();

// When the model calls the shell_script tool the tool loop suspends here,
// waiting for the frontend to send back terminal output over the WebSocket.
// The WebSocket message handler resolves the promise rather than starting a
// new agent turn.
const pendingShellScripts = new Map<string, (output: string) => void>();

async function runToolLoop(
  initialResult: AICompletionResult,
  session: SessionState,
  sessionId: string,
  send: AgentSendFn,
  log: typeof logger,
  tools: AITool[],
  mcpDispatch: Map<string, { serverId: string; mcpToolName: string }>,
  onUsage: (result: AICompletionResult) => Promise<void>,
): Promise<AICompletionResult> {
  // Tools the model is allowed to invoke on this turn. Built from the same
  // list we hand to the AI client, so flipping `WEB_SEARCH_ENABLED` (or any
  // future capability toggle) actually disables the tool at the execution
  // boundary, not just at registration. Without this set, a model that
  // already saw web_search/web_fetch on a previous turn — or one that
  // hallucinates a tool name — could still slip a call through to
  // executeTool(). See CodeRabbit PR #18 review.
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  let toolIterations = 0;
  let result = initialResult;

  while (result.finish_reason === 'tool_calls') {
    toolIterations++;

    const toolCalls = result.tool_calls ?? [];

    // If the model claims tool_calls but sent none, treat it as a normal text
    // response — pushing an assistant message with no following tool results
    // would leave the history ending with an assistant turn, causing a 400.
    if (!toolCalls.length) break;

    pushToSessionHistory(logger, session, result.assistantMessage);
    log.info('Agent executing tool calls', {
      sessionId,
      turn: session.turns,
      toolIteration: toolIterations,
      tools: toolCalls.map((tc) => tc.name),
    });

    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        const args = tc.arguments as Record<string, unknown>;

        if (tc.name.startsWith(MCP_TOOL_PREFIX)) {
          send({
            session_id: sessionId,
            sender: 'agent',
            content: `Calling MCP tool: ${tc.name}`,
            is_terminal_output: false,
            is_error: false,
            is_web_call: false,
            is_mcp_call: true,
          });
          const toolResult = await executeMcpTool(tc.name, args, mcpDispatch, log);
          log.info('Tool call completed', {
            sessionId,
            tool: tc.name,
            resultLength: toolResult.length,
          });
          return { id: tc.id, name: tc.name, result: toolResult };
        }

        if (tc.name === 'generate_image') {
          const prompt = typeof args.prompt === 'string' ? args.prompt : '';
          send({
            session_id: sessionId,
            sender: 'agent',
            content: `Generating image: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
            is_terminal_output: false,
            is_error: false,
            is_web_call: false,
            is_image_rendering: true,
          });

          const toolResult = await executeImageGenerationTool(args, log);
          log.info('Tool call completed', {
            sessionId,
            tool: tc.name,
            resultLength: toolResult.length,
          });

          send({
            session_id: sessionId,
            sender: 'agent',
            content: `Image saved to: ${toolResult}`,
            is_terminal_output: false,
            is_error: false,
            is_web_call: false,
            is_image_rendering: true,
          });

          return { id: tc.id, name: tc.name, result: toolResult };
        }

        // shell_script is a real tool: send the script to the frontend and
        // suspend until the WebSocket handler resolves the pending promise
        // with the terminal output (or an error string).
        if (tc.name === 'shell_script') {
          const script = typeof args.script === 'string' ? args.script : '';
          log.info('Agent invoking shell_script tool; forwarding to frontend', {
            sessionId,
            toolIteration: toolIterations,
            scriptLength: script.length,
          });
          send({
            session_id: sessionId,
            sender: 'agent',
            content: `<shell_script>\n${script}\n</shell_script>`,
            is_terminal_output: false,
            is_error: false,
          });
          const terminalOutput = await new Promise<string>((resolve) => {
            pendingShellScripts.set(sessionId, resolve);
          });
          return { id: tc.id, name: tc.name, result: terminalOutput };
        }

        // If the tool is not in the per-turn allowed list (e.g. the user
        // disabled web search via Settings → Agent Access, or the model
        // hallucinated a tool name), refuse the call instead of forwarding
        // it to executeTool. Returning a structured error lets the model
        // recover on its own turn without us silently running a disabled
        // capability. See CodeRabbit PR #18 review.
        if (!allowedToolNames.has(tc.name)) {
          log.warn('Refusing tool call: tool is not enabled for this session', {
            sessionId,
            tool: tc.name,
            allowed: Array.from(allowedToolNames),
          });
          send({
            session_id: sessionId,
            sender: 'agent',
            content: `Tool "${tc.name}" is not enabled for this session.`,
            is_terminal_output: false,
            is_error: true,
          });
          return {
            id: tc.id,
            name: tc.name,
            result:
              `Error: Tool "${tc.name}" is not enabled for this session. ` +
              `Available tools: ${Array.from(allowedToolNames).join(', ') || '(none)'}.`,
          };
        }

        // Notify the frontend that a web tool call is about to execute.
        const webCallContent =
          tc.name === 'web_search'
            ? `Searching the web for: "${String(args.query ?? '')}"`
            : `Fetching URL: ${String(args.url ?? '')}`;
        send({
          session_id: sessionId,
          sender: 'agent',
          content: webCallContent,
          is_terminal_output: false,
          is_error: false,
          is_web_call: true,
        });

        const toolResult = await executeTool(tc.name, args as Record<string, string>, log);
        log.info('Tool call completed', {
          sessionId,
          tool: tc.name,
          resultLength: toolResult.length,
        });
        return { id: tc.id, name: tc.name, result: toolResult };
      }),
    );

    for (const { id, name, result: toolResult } of toolResults) {
      pushToSessionHistory(logger, session, {
        role: 'tool',
        tool_call_id: id,
        tool_name: name,
        content: toolResult,
      });
    }

    // Call the AI again with the tool results in history to get the next response.
    result = await aiClient.complete(aiModel, session.history, {
      tools: tools.length ? tools : undefined,
      temperature: 0.2,
    });
    await onUsage(result);
  }

  log.info('Finished reasoning and tool calls: ', {
    reason: result.finish_reason,
  });

  return result;
}

const aiModel = getDefaultModel(config.aiProvider, 'smart');
const contextWindowSize = getContextWindowSize(config.aiProvider);

// ─── Terminal output helpers ──────────────────────────────────────────────────

const TERMINAL_OUTPUT_MAX = 80_000; // max chars kept per terminal message
const TERMINAL_OUTPUT_HEAD = 30_000; // chars kept from the beginning
const TERMINAL_OUTPUT_TAIL = 50_000; // chars kept from the end (errors land here)

/**
 * Caps large terminal outputs so they don't consume the entire history budget.
 * Keeps the first TERMINAL_OUTPUT_HEAD chars and the last TERMINAL_OUTPUT_TAIL
 * chars, inserting a truncation notice in the middle. The tail is larger because
 * errors and final results appear at the end.
 */
function truncateTerminalOutput(output: string): string {
  if (output.length <= TERMINAL_OUTPUT_MAX) return output;
  const dropped = output.length - TERMINAL_OUTPUT_HEAD - TERMINAL_OUTPUT_TAIL;
  return (
    output.slice(0, TERMINAL_OUTPUT_HEAD) +
    `\n\n[... ${dropped.toLocaleString()} chars of output omitted — showing first ${TERMINAL_OUTPUT_HEAD.toLocaleString()} and last ${TERMINAL_OUTPUT_TAIL.toLocaleString()} chars ...]\n\n` +
    output.slice(output.length - TERMINAL_OUTPUT_TAIL)
  );
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Sanitize LLM content before processing or forwarding to the client.
 *
 * Two known hallucination patterns are fixed here:
 *
 * 1. <shell_function_calls> wrapper — the model sometimes wraps <shell_script>
 *    in a <shell_function_calls> envelope.  Stored verbatim it compounds on
 *    every turn (double/triple nesting), so we strip every occurrence.
 *
 * 2. Mismatched closing tag — the model opens with <shell_script> but closes
 *    with a different tag (e.g. </shell_function>, </shell>, </script>).  The
 *    macOS client's extractor looks for </shell_script> exactly; a wrong tag
 *    makes it treat the entire script as plain reasoning text and call
 *    receiveNext(), while the backend waits for terminal output — a deadlock.
 *    We normalise any </shell…> variant to </shell_script> when the correct
 *    closing tag is absent.
 */
function sanitizeLLMContent(content: string): string {
  // 1. Strip <shell_function_calls> wrapper tags.
  let result = content.replace(/<\/?shell_function_calls>/gi, '');

  // 2. If <shell_script> is present but </shell_script> is missing,
  //    replace any stray </shell…> closing tag with the correct one.
  if (result.includes('<shell_script>') && !result.includes('</shell_script>')) {
    result = result.replace(/<\/shell\w*>/gi, '</shell_script>');
  }

  return result.trim();
}

async function persistSessionToDB(sessionId: string, state: SessionState): Promise<void> {
  try {
    const historyJson = JSON.stringify(state.history);
    await AgentSession.update(
      {
        historyJson,
        turns: state.turns,
        lastActiveAt: new Date(),
      },
      { where: { id: sessionId } },
    );
  } catch (err) {
    logger.error('Failed to persist agent session to DB', { sessionId, error: err });
  }
}

// Maximum number of sessions stored per subscription. When this limit is
// exceeded the oldest sessions (by lastActiveAt) are pruned automatically.
const SESSION_CAP = 50;

async function enforceSessionCap(subscriptionId: string, logger: Logger): Promise<void> {
  try {
    const count = await AgentSession.count({ where: { subscriptionId } });
    if (count <= SESSION_CAP) return;

    const excess = count - SESSION_CAP;
    const oldest = await AgentSession.findAll({
      where: { subscriptionId },
      order: [['last_active_at', 'ASC']],
      limit: excess,
      attributes: ['id'],
    });

    const ids = oldest.map((s) => s.id);
    await AgentSession.destroy({ where: { id: ids } });
    logger.info('Pruned oldest agent sessions to enforce cap', {
      subscriptionId,
      pruned: ids.length,
    });
  } catch (err) {
    logger.error('Failed to enforce agent session cap', { subscriptionId, error: err });
  }
}

async function getOrCreateSession(
  sessionId: string,
  subscription: Subscription,
  platform: string | undefined,
  log: typeof logger,
  isCronJob = false,
  groupName?: string,
): Promise<{ sessionState: SessionState; hasStoredPrompt: boolean; resumedSession: boolean }> {
  // 1. Try to resume from a persisted DB record.
  try {
    const dbSession = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId: subscription.id },
    });

    if (dbSession) {
      const history = JSON.parse(dbSession.historyJson) as SessionState['history'];
      const entry: SessionState = {
        subscription,
        history,
        turns: dbSession.turns,
        groupName: dbSession.groupName ?? null,
      };
      log.info('Resumed agent session from DB', {
        sessionId,
        subscriptionId: subscription.id,
        turns: entry.turns,
      });
      return {
        sessionState: entry,
        hasStoredPrompt: history
          .filter((h) => h.role === 'user')
          .some(
            (h) => typeof h.content === 'string' && h.content.includes('<stored_instructions>'),
          ),
        resumedSession: true,
      };
    }
  } catch (err) {
    log.error('Failed to load agent session from DB; creating a fresh one', {
      sessionId,
      error: err,
    });
  }

  // 2. Create a brand-new session and persist it to the DB.
  const prompt = await getPromptForCommand(log, 'task', subscription).catch((err) => {
    log.error('Failed to get system prompt for new agent session', { error: err });
    return '';
  });

  const installedMcps = await getPromptMcpsForSubscription(subscription.id, log);

  const systemPrompt = getAgentPrompt(platform, !isCronJob && !!prompt, installedMcps);

  const entry: SessionState = {
    subscription,
    history: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...(prompt && !isCronJob
        ? [
            {
              role: 'user' as const,
              content: `<stored_instructions>
# Stored Instructions

"""
${prompt}
"""
</stored_instructions>`,
            },
          ]
        : []),
    ],
    turns: 0,
  };

  // Persist immediately so that GET /sessions picks it up right away.
  try {
    const [dbSession, created] = await AgentSession.findOrCreate({
      where: { id: sessionId, subscriptionId: subscription.id },
      defaults: {
        id: sessionId,
        subscriptionId: subscription.id,
        title: 'New Session',
        platform: platform ?? null,
        historyJson: JSON.stringify(entry.history),
        turns: 0,
        lastActiveAt: new Date(),
        groupName: groupName ?? null,
      },
    });

    if (!created) {
      const history = JSON.parse(dbSession.historyJson || '[]') as SessionState['history'];
      const existingEntry: SessionState = {
        subscription,
        history,
        turns: dbSession.turns,
        groupName: dbSession.groupName ?? null,
      };

      log.info('Reused existing agent session row from DB during create path', {
        sessionId,
        subscriptionId: subscription.id,
        turns: existingEntry.turns,
      });

      return {
        sessionState: existingEntry,
        hasStoredPrompt: history
          .filter((h) => h.role === 'user')
          .some(
            (h) => typeof h.content === 'string' && h.content.includes('<stored_instructions>'),
          ),
        resumedSession: true,
      };
    }

    // Prune oldest sessions after each creation so the cap is always respected.
    void enforceSessionCap(subscription.id, log);
  } catch (err) {
    log.error('Failed to create agent session in DB', { sessionId, error: err });
  }

  log.info('Created new agent session', {
    sessionId,
    subscriptionId: subscription.id,
    hasCustomPrompt: Boolean(prompt),
  });
  return {
    sessionState: entry,
    hasStoredPrompt: !!prompt,
    resumedSession: false,
  };
}

async function runAgentTurnInternal(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: typeof logger,
  options?: { isCronJob?: boolean; untaggedDepth?: number },
): Promise<TurnOutcome> {
  const {
    sessionState: session,
    hasStoredPrompt,
    resumedSession,
  } = await getOrCreateSession(
    sessionId,
    subscription,
    clientMessage.platform,
    log,
    options?.isCronJob,
    clientMessage.group_name,
  );

  // Count this call as one agent iteration.
  session.turns += 1;

  log.info('Starting agent turn', {
    sessionId,
    subscriptionId: subscription.id,
    turn: session.turns,
    resumedSession,
  });

  // Append the client message as user content, marking terminal
  // output and errors in the text so the agent can reason about them.
  let userContent = clientMessage.content || '';
  const isTerminalOutput = Boolean(clientMessage.is_terminal_output);
  const isErrorFlag = Boolean(clientMessage.is_error);

  if (isTerminalOutput) {
    userContent = `TERMINAL OUTPUT:\n${truncateTerminalOutput(userContent)}`;
  }
  if (isErrorFlag) {
    userContent = `COMMAND ERROR:\n${truncateTerminalOutput(userContent)}`;
  }

  // If the client specified a group_name, look up the stored description
  // and prepend it as a <project_context> block. The frontend never sends
  // the description itself — the server is the single source of truth.
  if (
    clientMessage.group_name &&
    !isTerminalOutput &&
    !isErrorFlag &&
    !clientMessage.is_web_call &&
    !resumedSession
  ) {
    try {
      // The <project_context> block is now assembled from (a) the group's
      // stored project root + a confidence signal vs the path the user is
      // typing about, (b) the group's slow-changing purpose/language meta,
      // and (c) the last 5 sibling sessions' per-session summaries with
      // timestamps. This replaces the previous behaviour where the block
      // was just the group's single rolling description — a description
      // that got rewritten by every new session's first turn, wiping out
      // accumulated context.
      //
      // We pass the CURRENT turn's text as the only "input" so confidence
      // can compare the stored project root against any path the user just
      // typed. We do NOT include older messages from this session because
      // they have already been re-injected as their own <project_context>
      // on previous turns and re-extracting them now would just amplify
      // any prior path-detection error.
      const ctx = await buildProjectContext(
        subscription.id,
        clientMessage.group_name,
        [clientMessage.content || ''],
        sessionId,
      );
      if (ctx?.text) {
        logger.info('Prepending <project_context> block to user content', {
          sessionId,
          groupName: clientMessage.group_name,
          text: ctx.text,
        });
        userContent = `${ctx.text}\n\n${userContent}`;
      }
    } catch (err) {
      log.warn('Failed to build <project_context> block', { error: err });
    }
  }

  log.info('Agent turn received client message', {
    sessionId,
    isTerminalOutput,
    isError: isErrorFlag,
    rawContentLength: (clientMessage.content || '').length,
    userContentLength: userContent.length,
    isRecursiveCall: clientMessage.is_web_call,
  });

  const isAssistance = isTerminalOutput || isErrorFlag;

  if (!clientMessage?.is_web_call) {
    // Terminal output and command errors are always user-role messages — they
    // represent environment feedback that the agent must reason about next.
    // Pushing them as 'assistant' would create two consecutive assistant turns
    // which breaks most LLM APIs and prevents the model from processing the output.
    pushToSessionHistory(logger, session, {
      role: 'user',
      content: isAssistance
        ? userContent
        : [
            `<user_input>`,
            !options?.isCronJob
              ? createUserContent(userContent, hasStoredPrompt)
              : createUserContentForCronJob(userContent),
            `</user_input>`,
          ].join('\n'),
    });

    // Use the first real user message (turn 1) as the session title.
    if (session.turns === 1 && !isAssistance) {
      const rawInput = clientMessage.content || '';
      const titleSlug = rawInput.trim().slice(0, 60).replace(/\s+/g, ' ');
      if (titleSlug) {
        AgentSession.update({ title: titleSlug }, { where: { id: sessionId } }).catch((err) => {
          log.error('Failed to update agent session title', { sessionId, error: err });
        });
      }
    }
  }

  const mcpBundle = await getMcpToolsForSubscription(subscription.id, log);
  // gpt-5.5 (Responses API) already has execute_shell_script wired internally;
  // all other providers get shell_script as a native function tool so the model
  // can call it directly instead of emitting XML tags.
  //
  // When the user has set TERMINAL_ACCESS=limited via Settings → Agent Access,
  // we expose the same tool name but with a description that tells the model
  // to stay within read-only / inspection commands. The Responses API path
  // injects its equivalent restriction inside ai-client.ts (see
  // shellScriptToolDescriptionForMode there).
  const shellTool =
    config.terminalAccess === 'limited' ? SHELL_SCRIPT_TOOL_LIMITED : SHELL_SCRIPT_TOOL;
  const shellTools: AITool[] = aiModel !== RESPONSES_API_MODEL ? [shellTool] : [];
  const tools = buildAvailableTools([...shellTools, ...mcpBundle.aiTools]);

  const recordUsage = async (result: AICompletionResult) => {
    const usage = result.usage;
    if (!usage) return;

    // Always update the per-session token counters in the DB.
    try {
      await AgentSession.increment(
        {
          promptTokensUsed: usage.prompt_tokens,
          completionTokensUsed: usage.completion_tokens,
          totalTokensUsed: usage.total_tokens,
        },
        { where: { id: sessionId } },
      );
      // Track the most recent prompt size so the UI can show accurate
      // "tokens remaining" without the cumulative-sum skew of promptTokensUsed.
      await AgentSession.update(
        { lastPromptTokens: usage.prompt_tokens },
        { where: { id: sessionId } },
      );
    } catch (err) {
      log.error('Failed to update agent session token usage', { sessionId, error: err });
    }

    if (!subscription.id || config.isSelfHosted) return;
    try {
      await SubscriptionUsage.create({
        subscriptionId: subscription.id,
        model: result.model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      });
      await Subscription.increment('totalTokensUsed', {
        by: usage.total_tokens,
        where: { id: subscription.id },
      });
    } catch (err) {
      log.error('Failed to record subscription usage metrics for agent.', {
        error: err,
        subscriptionId: subscription.id,
      });
    }
  };

  try {
    log.debug('Calling AI provider for agent turn', {
      sessionId,
      provider: config.aiProvider,
      model: aiModel,
      turn: session.turns,
      historyLength: session.history.length,
    });

    let result = await aiClient.complete(aiModel, session.history, {
      tools: tools?.length ? tools : undefined,
      temperature: 0.2,
    });

    await recordUsage(result);

    // When the model's output was cut off mid-generation (hit the provider's
    // max-token ceiling), it may have produced a partial shell script or plain
    // reasoning text with no closing tag.  Processing that as-is would either
    // send a malformed script to the frontend or silently recurse without any
    // recovery signal.  Instead, push the truncated fragment as an assistant
    // message and inject a terse directive that forces the model to emit a
    // valid tag on the very next call.
    if (result.finish_reason === 'length') {
      log.warn('Agent response truncated at output limit; injecting recovery directive', {
        sessionId,
        contentLength: result.content.length,
      });
      if (result.content.trim()) {
        pushToSessionHistory(logger, session, result.assistantMessage);
      }
      pushToSessionHistory(logger, session, {
        role: 'user',
        content: [
          'Your previous response was cut off because it exceeded the output length limit.',
          'Do NOT repeat or continue what you wrote.',
          'Respond immediately with exactly one of:',
          '- <shell_script>...</shell_script>',
          '- <final_answer>...</final_answer>',
          'No reasoning. No explanation. Just the tag.',
        ].join('\n'),
      });
      result = await aiClient.complete(aiModel, session.history, {
        tools: tools?.length ? tools : undefined,
        temperature: 0.2,
      });
      await recordUsage(result);
    }

    let content = sanitizeLLMContent(result.content.trim());

    if (!content && result.finish_reason !== 'tool_calls') {
      log.warn('Agent LLM returned empty content; sending generic error to client.');

      const errorMessage = 'The agent returned an empty response. Please try again.';

      await persistSessionToDB(sessionId, session);
      sendFinalAnswer(send, sessionId, errorMessage, true);
      return 'complete';
    }

    // If the model requested web tool calls, execute them and get a follow-up
    // response before deciding what to send to the client.
    if (result.finish_reason === 'tool_calls') {
      log.info('Running web tool calls to gather information', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
      });

      const toolLoopResult = await runToolLoop(
        result,
        session,
        sessionId,
        send,
        log,
        tools,
        mcpBundle.dispatch,
        recordUsage,
      );
      const toolLoopContent = sanitizeLLMContent(toolLoopResult.content.trim());

      const toolLoopHasShell = toolLoopContent.includes('<shell_script>');
      const toolLoopHasFinal = toolLoopContent.includes('<final_answer>');
      const webToolFailed = session.history.some(
        (msg) =>
          msg.role === 'tool' &&
          (msg.tool_name === 'web_search' || msg.tool_name === 'web_fetch') &&
          typeof msg.content === 'string' &&
          msg.content.startsWith('Error'),
      );

      if (toolLoopHasShell || (toolLoopHasFinal && !webToolFailed)) {
        // The tool loop already produced a shell script — use it directly.
        // This avoids a redundant AI call and handles the case where the model
        // emits a <shell_script> immediately after its web tool calls.
        log.info('Tool loop produced shell script; processing inline', { sessionId });
        content = toolLoopContent;
        result = toolLoopResult;
        // Fall through to the <shell_script> handling below.
      } else {
        // The tool loop returned either plain text or a <final_answer>.
        // We always make one more AI turn here so the model has a chance to
        // correct itself — specifically when web tools failed (404 / error) the
        // model tends to wrap a "please run this manually" message in
        // <final_answer>. The directive below tells it to use <shell_script> as
        // a fallback instead of asking the user to run commands.
        if (toolLoopResult.assistantMessage) {
          pushToSessionHistory(logger, session, toolLoopResult.assistantMessage);
        }

        pushToSessionHistory(logger, session, {
          role: 'user',
          content: webToolFailed
            ? [
                'IMPORTANT: The web search tool failed and is unavailable. Do NOT attempt any further web calls or ask the user to run commands manually.',
                'You MUST retrieve any needed data by generating a <shell_script> that runs terminal commands (curl, grep, cat, etc.).',
                'The shell script output will be returned to you automatically.',
                '',
                'Respond with exactly one of:',
                '- <shell_script>...</shell_script> — to fetch or retrieve data via terminal commands',
                '- <final_answer>...</final_answer> — only if you already have enough information',
                'No plain text. No web tool calls. No other format.',
              ].join('\n')
            : [
                'Web research is complete. The results are in the conversation above.',
                '',
                'Now respond with exactly one of:',
                '- <shell_script>...</shell_script> — to run terminal commands (output will be returned to you automatically)',
                '- <final_answer>...</final_answer> — only if you genuinely have enough information',
                'No plain text. No other format.',
              ].join('\n'),
        });

        // DB-only session state: persist before recursive handoff so the
        // follow-up turn reads the latest history and turn count.
        await persistSessionToDB(sessionId, session);

        return await runAgentTurnInternal(
          sessionId,
          subscription,
          {
            sender: 'agent',
            session_id: sessionId,
            content: '',
            is_web_call: true,
          },
          send,
          logger,
          options,
        );
      }
    }

    const hasShellScriptTag = content.includes('<shell_script>');
    const hasFinalAnswerTag = content.includes('<final_answer>');

    if (hasShellScriptTag) {
      log.info('Completed agent turn. Sending back scripts, waiting for results.', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
        responseLength: result.content.length,
      });

      pushToSessionHistory(logger, session, {
        role: 'assistant',
        content,
      });

      // Persist before sending so that if the send callback triggers a new
      // runAgentTurn immediately (e.g. cron shell-script loop), the DB already
      // has the updated turn count and history.
      await persistSessionToDB(sessionId, session);

      send({
        session_id: sessionId,
        sender: 'agent',
        content,
        is_terminal_output: false,
        is_error: false,
      });
      return 'shell_pending';
    }

    if (hasFinalAnswerTag) {
      log.info('Finalizing agent session after final answer tag', {
        sessionId,
        subscriptionId: subscription.id,
        turns: session.turns,
        hasFinalAnswerTag,
      });

      pushToSessionHistory(logger, session, { role: 'assistant', content });
      await persistSessionToDB(sessionId, session);
      send({
        session_id: sessionId,
        sender: 'agent',
        content: hasFinalAnswerTag ? content : `<final_answer>\n${content}\n</final_answer>`,
      });
      // Only re-classify when the session doesn't already have a group name.
      // Re-classification is expensive (LLM call) and unnecessary once a group
      // has been assigned — the cron in sessionGrouping.ts is responsible for
      // periodic refreshes if descriptions ever need updating.
      if (!session.groupName) {
        void updateSessionGroup(sessionId, subscription.id).then(async () => {
          // Reflect the newly-assigned group back into the in-memory session
          // so subsequent turns in this same session also skip re-classification.
          try {
            const refreshed = await AgentSession.findOne({
              where: { id: sessionId, subscriptionId: subscription.id },
              attributes: ['groupName'],
            });
            if (refreshed?.groupName) {
              session.groupName = refreshed.groupName;
            }
          } catch (err) {
            log.warn('Failed to read back groupName after classification', { error: err });
          }
        });
      } else {
        log.info('Skipping session group classification — group already assigned', {
          sessionId,
          groupName: session.groupName,
        });
      }
    } else if (content) {
      const untaggedDepth = options?.untaggedDepth ?? 0;

      // Safety valve: after two consecutive format-correction attempts the
      // model is clearly stuck.  Abort rather than loop indefinitely.
      if (untaggedDepth >= 2) {
        log.warn('Agent stuck in untagged response loop; aborting after max retries', {
          sessionId,
          untaggedDepth,
        });
        await persistSessionToDB(sessionId, session);
        sendFinalAnswer(
          send,
          sessionId,
          'The agent failed to produce a structured response after multiple attempts. Please try again.',
          true,
        );
        return 'complete';
      }

      log.info('Agent returned untagged content; injecting format-correction directive', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
        untaggedDepth,
      });

      // Push the untagged content as an assistant turn so the model sees what
      // it wrote, then immediately follow with a user message that firmly
      // redirects it back to the required tag format.
      pushToSessionHistory(logger, session, { role: 'assistant', content });
      pushToSessionHistory(logger, session, {
        role: 'user',
        content: [
          'Your response was plain text, which is not a valid format.',
          'You MUST respond with exactly one of:',
          '- <shell_script>...</shell_script> — to run terminal commands',
          '- <final_answer>...</final_answer> — to conclude',
          'Respond immediately with the tag. No reasoning, no explanation.',
        ].join('\n'),
      });
      await persistSessionToDB(sessionId, session);
      return await runAgentTurnInternal(
        sessionId,
        subscription,
        {
          sender: 'agent',
          session_id: sessionId,
          content: '',
          is_web_call: true,
        },
        send,
        logger,
        { ...options, untaggedDepth: untaggedDepth + 1 },
      );
    } else {
      log.warn('Agent returned empty content with no recognized tags; sending error', {
        sessionId,
      });
      await persistSessionToDB(sessionId, session);
      sendFinalAnswer(
        send,
        sessionId,
        'The agent returned an empty response. Please try again.',
        true,
      );
    }
  } catch (err) {
    log.error('Agent LLM call failed', {
      error: {
        message: err instanceof Error ? err.message : String(err),
        status: (err as any).status,
        type: (err as any).error?.type ?? (err as any).type,
        code: (err as any).code,
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined,
      },
    });
    const errorMessage = 'Agent failed to call language model. Please try again later.';
    await persistSessionToDB(sessionId, session);
    sendFinalAnswer(send, sessionId, errorMessage, true);
  }
  return 'complete';
}

export async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: typeof logger,
  options?: { isCronJob?: boolean },
): Promise<TurnOutcome> {
  // untaggedDepth always starts at 0 for external callers; it is only threaded
  // through the internal recursive path.
  return runAgentTurnInternal(sessionId, subscription, clientMessage, send, log, options);
}

async function processNextInQueue(sessionId: string): Promise<void> {
  const queue = sessionQueues.get(sessionId);
  if (!queue?.length) return;

  const next = queue.shift()!;
  if (!queue.length) sessionQueues.delete(sessionId);

  activeSessions.add(sessionId);
  try {
    const outcome = await runAgentTurn(
      sessionId,
      next.subscription,
      next.message,
      next.send,
      next.log,
    );
    if (outcome === 'complete') {
      activeSessions.delete(sessionId);
      void processNextInQueue(sessionId);
    }
    // 'shell_pending': keep active; terminal output arriving later will complete the turn
  } catch {
    activeSessions.delete(sessionId);
    void processNextInQueue(sessionId);
  }
}

export function attachAgentWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/omni-agent' });

  wss.on('connection', (ws: WebSocket, req) => {
    const traceId = cuid();
    const log = logger.child({ traceId });

    log.info('Agent WebSocket connection opened');

    const authHeaderValue = req.headers['authorization'];
    const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;

    const { ensureAuthenticated, getSubscription } = createLazyAuthContext(authHeader, log);

    const send: AgentSendFn = (msg) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        log.error('Failed to write AgentMessage to WebSocket', { error: err });
      }
    };

    // Track session IDs touched by this connection so we can clean up on close.
    const connectionSessionIds = new Set<string>();

    ws.on('message', (data) => {
      void (async () => {
        const ok = await ensureAuthenticated();
        const subscription = getSubscription();

        if (!ok || !subscription) {
          if (ws.readyState === WebSocket.OPEN) {
            log.warn('Closing Agent WebSocket due to failed authentication');
            send({
              session_id: '',
              sender: 'agent',
              content:
                'Unauthorized: missing or invalid subscription. Please re-activate your key.',
              is_terminal_output: false,
              is_error: true,
            });
            ws.close();
          }
          return;
        }

        let message: AgentMessage;
        try {
          const text = typeof data === 'string' ? data : data.toString('utf8');
          log.info('Agent WebSocket received message from client', {
            approximateLength: text.length,
          });
          message = JSON.parse(text) as AgentMessage;
        } catch (err) {
          log.warn('Received invalid AgentMessage payload over WebSocket', { error: err });
          return;
        }

        const sessionId = message.session_id || 'default';
        connectionSessionIds.add(sessionId);
        log.debug('Received AgentMessage from client (WebSocket)', {
          sessionId,
          sender: message.sender,
          isTerminalOutput: message.is_terminal_output,
          isError: message.is_error,
        });

        // Terminal feedback (shell output / errors) and internal recursive calls
        // always bypass the queue — they are part of the currently active turn.
        const isTerminalFeedback = Boolean(message.is_terminal_output) || Boolean(message.is_error);
        const isInternalCall = Boolean(message.is_web_call);

        if (!isTerminalFeedback && !isInternalCall && activeSessions.has(sessionId)) {
          // A turn is already running for this session. Queue the message so it
          // is processed in order once the current turn completes.
          const queue = sessionQueues.get(sessionId) ?? [];
          queue.push({ message, send, subscription, log });
          sessionQueues.set(sessionId, queue);
          log.info('Queued user message for active session', {
            sessionId,
            queueLength: queue.length,
          });
          return;
        }

        // If the tool loop is awaiting shell_script terminal output, resolve
        // the pending promise instead of starting a new agent turn.
        const shellResolver = pendingShellScripts.get(sessionId);
        if (shellResolver && isTerminalFeedback) {
          pendingShellScripts.delete(sessionId);
          const content = message.is_error
            ? `COMMAND ERROR:\n${message.content ?? ''}`
            : `TERMINAL OUTPUT:\n${message.content ?? ''}`;
          log.info('Resolving pending shell_script tool result from terminal output', {
            sessionId,
            isError: Boolean(message.is_error),
          });
          shellResolver(content);
          return;
        }

        activeSessions.add(sessionId);
        const outcome = await runAgentTurn(sessionId, subscription, message, send, log);
        if (outcome === 'complete') {
          activeSessions.delete(sessionId);
          void processNextInQueue(sessionId);
        }
        // 'shell_pending': keep active; terminal output will eventually unlock it
      })();
    });

    ws.on('error', (err) => {
      log.warn('Agent WebSocket error', { error: err });
    });

    ws.on('close', () => {
      log.info('Agent WebSocket connection closed', {
        hadAuthenticatedSubscription: Boolean(getSubscription()),
      });

      // When the client disconnects, resolve any shell_script tool call that
      // is suspended waiting for terminal output — otherwise runToolLoop hangs
      // indefinitely. Deliver a COMMAND ERROR so the model can conclude gracefully.
      for (const sid of connectionSessionIds) {
        const shellResolver = pendingShellScripts.get(sid);
        if (shellResolver) {
          pendingShellScripts.delete(sid);
          shellResolver(
            'COMMAND ERROR:\nWebSocket connection closed before script output was received.',
          );
          log.info('Resolved pending shell_script with disconnect error', { sessionId: sid });
        }
      }

      // Sessions that were shell_pending (waiting for terminal output that will
      // never arrive) stay stuck in activeSessions indefinitely, causing all
      // follow-up messages to queue forever. Clean them up so a reconnecting
      // client can resume without being stuck.
      for (const sid of connectionSessionIds) {
        const wasActive = activeSessions.has(sid);
        const queueLength = sessionQueues.get(sid)?.length ?? 0;

        if (wasActive || queueLength > 0) {
          activeSessions.delete(sid);
          sessionQueues.delete(sid);
          log.info('Cleaned up stuck session state after WebSocket disconnect', {
            sessionId: sid,
            wasActive,
            drainedQueueLength: queueLength,
          });
        }
      }

      // Session-end hook: when the WebSocket closes the user has stopped
      // typing, so this is the right moment to (re)generate each touched
      // session's sessionSummary. The summary feeds future <project_context>
      // blocks under "Recent sessions in this project". We deliberately do
      // NOT block the close handler on the LLM call — fire-and-forget with
      // its own error logging so a slow LLM provider can't keep the
      // connection close path waiting.
      const sub = getSubscription();
      if (sub) {
        for (const sid of connectionSessionIds) {
          void summariseSession(sid, sub.id).catch((err) => {
            log.warn('summariseSession on WebSocket close failed', {
              sessionId: sid,
              error: err,
            });
          });
        }
      }
    });
  });

  logger.info('Agent WebSocket server attached at path /ws/omni-agent');

  return wss;
}

// ─── Session transcript helpers ──────────────────────────────────────────────

type HistoryBlockKind =
  | 'agentReasoning'
  | 'shellCommand'
  | 'terminalOutput'
  | 'webCall'
  | 'mcpCall'
  | 'imageRendering'
  | 'finalAnswer';

type RawHistoryMessage = {
  role: string;
  content: unknown;
  tool_name?: string;
  tool_calls?: unknown[];
};

type TranscriptBlock = {
  id: string;
  kind: HistoryBlockKind;
  text: string;
};

type TranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  blocks?: TranscriptBlock[];
};

function contentToString(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function extractTaggedBlock(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function removeTaggedBlock(text: string, tag: string): string {
  const pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return text.replace(pattern, '');
}

function cleanUserTranscriptText(text: string): string {
  return text
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/<project_context[^>]*>[\s\S]*?<\/project_context>/gi, '')
    .replace(/@omniagent/gi, '')
    .trim();
}

function cleanAssistantTranscriptText(text: string): string {
  return text
    .replace(/<final_answer>([\s\S]*?)<\/final_answer>/gi, '$1')
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/@omniagent/gi, '')
    .trim();
}

function terminalFeedbackText(text: string): string | null {
  let cleaned = text.trim();
  let isError = false;

  if (/^COMMAND ERROR:/i.test(cleaned)) {
    isError = true;
    cleaned = cleaned.replace(/^COMMAND ERROR:\s*/i, '').trim();
  }

  if (/^TERMINAL OUTPUT:/i.test(cleaned)) {
    cleaned = cleaned.replace(/^TERMINAL OUTPUT:\s*/i, '').trim();
  }

  if (!isError && cleaned === text.trim()) return null;

  return isError
    ? `Command error\n\n${cleaned || 'The command failed without output.'}`
    : cleaned || 'The command finished without output.';
}

function toolBlockKind(toolName?: string): HistoryBlockKind {
  if (!toolName) return 'agentReasoning';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcpCall';
  if (toolName === 'generate_image') return 'imageRendering';
  if (toolName === 'web_search' || toolName === 'web_fetch') return 'webCall';
  return 'agentReasoning';
}

function toolBlockText(toolName: string | undefined, content: string): string {
  const label = toolName ? `Tool: ${toolName}` : 'Tool result';
  return `${label}\n\n${content.trim() || 'No result text.'}`;
}

function buildTranscript(raw: RawHistoryMessage[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let currentAssistant: TranscriptMessage | null = null;
  let blockCount = 0;
  let assistantCount = 0;

  const makeBlock = (kind: HistoryBlockKind, text: string): TranscriptBlock => ({
    id: `block-${blockCount++}`,
    kind,
    text,
  });

  const ensureAssistant = (): TranscriptMessage => {
    if (!currentAssistant) {
      currentAssistant = {
        id: `assistant-${assistantCount++}`,
        role: 'assistant',
        text: '',
        blocks: [],
      };
    }
    return currentAssistant;
  };

  const flushAssistant = () => {
    const blocks = currentAssistant?.blocks ?? [];
    if (!currentAssistant || !blocks.length) {
      currentAssistant = null;
      return;
    }

    let finalText = '';
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'finalAnswer') {
        finalText = blocks[i].text;
        break;
      }
    }

    currentAssistant.text =
      finalText ||
      blocks
        .map((b) => b.text)
        .join('\n\n')
        .trim();
    messages.push(currentAssistant);
    currentAssistant = null;
  };

  const appendAssistantBlock = (kind: HistoryBlockKind, text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    ensureAssistant().blocks?.push(makeBlock(kind, cleaned));
  };

  raw.forEach((entry, index) => {
    const content = contentToString(entry.content);

    if (entry.role === 'system') return;

    if (entry.role === 'user') {
      const terminalText = terminalFeedbackText(content);
      if (terminalText) {
        appendAssistantBlock('terminalOutput', terminalText);
        return;
      }

      const userText = cleanUserTranscriptText(content);
      if (!userText) return;

      flushAssistant();
      messages.push({
        id: `${index}-user`,
        role: 'user',
        text: userText,
      });
      return;
    }

    if (entry.role === 'tool') {
      appendAssistantBlock(toolBlockKind(entry.tool_name), toolBlockText(entry.tool_name, content));
      return;
    }

    if (entry.role !== 'assistant') return;

    const finalAnswer = extractTaggedBlock(content, 'final_answer');
    if (finalAnswer) {
      appendAssistantBlock('finalAnswer', finalAnswer);
      return;
    }

    const shellScript = extractTaggedBlock(content, 'shell_script');
    if (shellScript) {
      const reasoning = cleanAssistantTranscriptText(removeTaggedBlock(content, 'shell_script'));
      appendAssistantBlock('agentReasoning', reasoning);
      appendAssistantBlock('shellCommand', shellScript);
      return;
    }

    const visible = cleanAssistantTranscriptText(content);
    if (!visible) return;

    const hasToolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
    appendAssistantBlock(hasToolCalls ? 'agentReasoning' : 'finalAnswer', visible);
  });

  flushAssistant();
  return messages;
}

// ─── REST router ─────────────────────────────────────────────────────────────
// Exposes agent session management endpoints that the macOS (and Windows)
// clients can call over plain HTTP before/during a session.

export function createAgentRouter(): express.Router {
  const router = express.Router();

  // Apply auth to every route in this router.
  router.use(authMiddleware);

  // GET /api/agent/sessions
  // Returns the most recent 50 sessions for the authenticated subscription,
  // ordered by last activity descending.
  router.get('/sessions', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    try {
      const sessions = await AgentSession.findAll({
        where: { subscriptionId: subscription.id },
        order: [['last_active_at', 'DESC']],
        limit: 50,
        attributes: [
          'id',
          'title',
          'platform',
          'turns',
          'totalTokensUsed',
          'promptTokensUsed',
          'completionTokensUsed',
          'lastPromptTokens',
          'groupName',
          'groupDescription',
          'lastActiveAt',
          'createdAt',
          'updatedAt',
        ],
      });

      res.json(
        sessions.map((s) => ({
          id: s.id,
          title: s.title,
          platform: s.platform,
          turns: s.turns,
          totalTokensUsed: Number(s.totalTokensUsed),
          promptTokensUsed: Number(s.promptTokensUsed),
          completionTokensUsed: Number(s.completionTokensUsed),
          remainingContextTokens: Math.max(0, contextWindowSize - Number(s.lastPromptTokens)),
          contextBudget: contextWindowSize,
          groupName: s.groupName ?? null,
          groupDescription: s.groupDescription ?? null,
          lastActiveAt: s.lastActiveAt,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      );
    } catch (err) {
      log.error('Failed to list agent sessions', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/agent/sessions/:sessionId
  // Allows the client to explicitly delete a session and its stored history.
  router.delete('/sessions/:sessionId', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const deleted = await AgentSession.destroy({
        where: { id: sessionId, subscriptionId: subscription.id },
      });

      if (deleted === 0) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.status(200).json({ deleted: true });
    } catch (err) {
      log.error('Failed to delete agent session', { sessionId, error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/:sessionId/context
  // Returns token usage and remaining context budget for a single session.
  router.get('/sessions/:sessionId/context', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    const { sessionId } = req.params;
    // Validate that sessionId is a well-formed non-empty string (no path traversal).
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const session = await AgentSession.findOne({
        where: { id: sessionId, subscriptionId: subscription.id },
        attributes: [
          'id',
          'title',
          'turns',
          'totalTokensUsed',
          'promptTokensUsed',
          'completionTokensUsed',
          'lastPromptTokens',
          'lastActiveAt',
        ],
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json({
        id: session.id,
        title: session.title,
        turns: session.turns,
        totalTokensUsed: Number(session.totalTokensUsed),
        promptTokensUsed: Number(session.promptTokensUsed),
        completionTokensUsed: Number(session.completionTokensUsed),
        remainingContextTokens: Math.max(0, contextWindowSize - Number(session.lastPromptTokens)),
        contextBudget: contextWindowSize,
        lastActiveAt: session.lastActiveAt,
      });
    } catch (err) {
      log.error('Failed to fetch agent session context', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/:sessionId/messages
  // Returns a typed, human-readable transcript of the session history.
  // Assistant messages include renderable blocks so resumed chat sessions can
  // show final answers, commands, terminal output, web/MCP calls, and images
  // with the same UX as live streaming.
  router.get('/sessions/:sessionId/messages', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const session = await AgentSession.findOne({
        where: { id: sessionId, subscriptionId: subscription.id },
        attributes: ['id', 'historyJson'],
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const raw: RawHistoryMessage[] = JSON.parse(session.historyJson || '[]');
      const messages = buildTranscript(raw);

      res.json({ messages });
    } catch (err) {
      log.error('Failed to fetch agent session messages', { sessionId, error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/groups
  // Returns distinct group names and descriptions for the authenticated
  // subscription. The client uses this to populate the project-path dropdown
  // and to filter the sidebar session list by project.
  router.get('/groups', async (_req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    try {
      const rows = await AgentSession.findAll({
        where: {
          subscriptionId: subscription.id,
          groupName: { [Op.not]: null },
        },
        attributes: ['groupName', 'groupDescription'],
        group: ['group_name'],
        order: [['groupName', 'ASC']],
      });

      const groups = rows
        .filter((r) => r.groupName)
        .map((r) => ({
          groupName: r.groupName!,
          groupDescription: r.groupDescription ?? null,
        }));

      res.json({ groups });
    } catch (err) {
      log.error('Failed to fetch session groups', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
