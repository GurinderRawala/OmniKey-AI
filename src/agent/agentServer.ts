import type http from 'http';
import express, { Response } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import cuid from 'cuid';
import { config } from '../config';
import { logger } from '../logger';
import { Subscription } from '../models/subscription';
import { SubscriptionUsage } from '../models/subscriptionUsage';
import { AgentSession } from '../models/agentSession';
import { getAgentPrompt } from './agentPrompts';
import { getPromptForCommand } from '../featureRoutes';
import { executeTool } from '../web-search/web-search-provider';
import { createLazyAuthContext } from './agentAuth';
import { authMiddleware, AuthLocals } from '../authMiddleware';
import { executeImageGenerationTool } from './imageTool';
import {
  buildAvailableTools,
  createUserContent,
  sendFinalAnswer,
  pushToSessionHistory,
  MAX_HISTORY_TOTAL,
  createUserContentForCronJob,
} from './utils';
import { aiClient, AITool, AICompletionResult, getDefaultModel } from '../ai-client';
import type { AgentMessage, AgentSendFn, SessionState } from './types';
import { Logger } from 'winston';

async function runToolLoop(
  initialResult: AICompletionResult,
  session: SessionState,
  sessionId: string,
  send: AgentSendFn,
  log: typeof logger,
  tools: AITool[],
  onUsage: (result: AICompletionResult) => Promise<void>,
): Promise<AICompletionResult> {
  const MAX_TOOL_ITERATIONS = 10;
  let toolIterations = 0;
  let result = initialResult;

  while (result.finish_reason === 'tool_calls' && toolIterations < MAX_TOOL_ITERATIONS) {
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

  // If we exhausted the iteration cap and the model still wants to call tools,
  // force a final text response by calling again without tools.
  if (result.finish_reason === 'tool_calls') {
    log.warn('Tool loop hit MAX_TOOL_ITERATIONS; forcing final conclusion', { sessionId });

    pushToSessionHistory(logger, session, result.assistantMessage);

    // The API requires a tool_result for every tool_use in the preceding
    // assistant message. Add synthetic results for any unexecuted calls so
    // the history remains valid before we send the follow-up user message.
    for (const tc of result.tool_calls ?? []) {
      pushToSessionHistory(logger, session, {
        role: 'tool',
        tool_call_id: tc.id,
        tool_name: tc.name,
        content: 'Tool call limit reached. Result unavailable.',
      });
    }

    pushToSessionHistory(logger, session, {
      role: 'user',
      content:
        'You have reached the maximum number of tool calls. Do NOT make any further tool calls or web searches. You MUST now provide a final answer directly. If you still need to gather information from the system, generate a `<shell_scripts>` block instead of making tool calls.',
    });

    result = await aiClient.complete(aiModel, session.history, {
      tools: undefined,
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

// In-memory cache: sessionId -> live SessionState. Hydrated from DB on first
// access and written back after each turn so restarts resume correctly.
const sessionMessages = new Map<string, SessionState>();

const MAX_TURNS = 20;


// ─── DB helpers ───────────────────────────────────────────────────────────────

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
): Promise<{ sessionState: SessionState; hasStoredPrompt: boolean }> {
  // 1. Return the live in-memory entry if already loaded this process lifetime.
  const existing = sessionMessages.get(sessionId);
  if (existing) {
    log.debug('Reusing existing agent session (in-memory)', {
      sessionId,
      subscriptionId: existing.subscription.id,
      turns: existing.turns,
    });
    return {
      sessionState: existing,
      hasStoredPrompt: existing.history
        .filter((h) => h.role === 'user')
        .some((h) => typeof h.content === 'string' && h.content.includes('<stored_instructions>')),
    };
  }

  // 2. Try to resume from a persisted DB record.
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
      };
      sessionMessages.set(sessionId, entry);
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
      };
    }
  } catch (err) {
    log.error('Failed to load agent session from DB; creating a fresh one', {
      sessionId,
      error: err,
    });
  }

  // 3. Create a brand-new session in-memory and persist it to the DB.
  const prompt = await getPromptForCommand(log, 'task', subscription).catch((err) => {
    log.error('Failed to get system prompt for new agent session', { error: err });
    return '';
  });

  const systemPrompt = getAgentPrompt(platform, !!prompt);

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

  sessionMessages.set(sessionId, entry);

  // Persist immediately so that GET /sessions picks it up right away.
  try {
    await AgentSession.create({
      id: sessionId,
      subscriptionId: subscription.id,
      title: 'New Session',
      platform: platform ?? null,
      historyJson: JSON.stringify(entry.history),
      turns: 0,
      lastActiveAt: new Date(),
    });
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
  };
}

export async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: typeof logger,
  options?: { maxTurns?: number; isCronJob?: boolean },
) {
  const { sessionState: session, hasStoredPrompt } = await getOrCreateSession(
    sessionId,
    subscription,
    clientMessage.platform,
    log,
    options?.isCronJob,
  );

  // Count this call as one agent iteration.
  session.turns += 1;

  log.info('Starting agent turn', {
    sessionId,
    subscriptionId: subscription.id,
    turn: session.turns,
  });

  const effectiveMaxTurns = options?.maxTurns ?? MAX_TURNS;

  // On the final iteration, instruct the LLM to provide a consolidated answer.
  if (session.turns === effectiveMaxTurns) {
    pushToSessionHistory(logger, session, {
      role: 'system',
      content:
        'Provide a single, final, concise answer based on the entire conversation so far. Wrap the answer in a <final_answer>...</final_answer> block and do not ask for further input or mention additional shell scripts to run. Do not include any <shell_script> block in this response.',
    });
  }

  // Append the client message as user content, marking terminal
  // output and errors in the text so the agent can reason about them.
  let userContent = clientMessage.content || '';
  const isTerminalOutput = Boolean(clientMessage.is_terminal_output);
  const isErrorFlag = Boolean(clientMessage.is_error);

  if (isTerminalOutput) {
    userContent = `TERMINAL OUTPUT:\n${userContent}`;
  }
  if (isErrorFlag) {
    userContent = `COMMAND ERROR:\n${userContent}`;
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

  // On the final turn we omit tools so the model is forced to emit a
  // plain text <final_answer> rather than issuing another tool call.
  const isFinalTurn = session.turns >= effectiveMaxTurns;
  const tools = isFinalTurn ? undefined : buildAvailableTools();

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

    let content = result.content.trim();

    if (!content && result.finish_reason !== 'tool_calls') {
      log.warn('Agent LLM returned empty content; sending generic error to client.');

      const errorMessage = 'The agent returned an empty response. Please try again.';

      sendFinalAnswer(send, sessionId, errorMessage, true);

      // Evict from the in-memory cache; the DB record is kept so the session
      // appears in the list and can be retried or deleted by the user.
      sessionMessages.delete(sessionId);
      return;
    }

    // If the model requested web tool calls, execute them and get a follow-up
    // response before deciding what to send to the client.
    if (!isFinalTurn && result.finish_reason === 'tool_calls') {
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
        buildAvailableTools(),
        recordUsage,
      );
      const toolLoopContent = toolLoopResult.content.trim();

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

        await runAgentTurn(
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

        return;
      }
    }

    // Ensure that a proper <final_answer> block is produced for the
    // desktop clients once we reach the final turn. If the model did
    // not emit either a <shell_script> or <final_answer> tag on the
    // MAX_TURNS turn, we treat this as the final natural-language answer
    // and wrap it in <final_answer> tags so the client can stop
    // waiting and paste the result.
    const hasShellScriptTag = content.includes('<shell_script>');
    const hasFinalAnswerTag = content.includes('<final_answer>');

    if (hasShellScriptTag && !isFinalTurn) {
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

      send({
        session_id: sessionId,
        sender: 'agent',
        content,
        is_terminal_output: false,
        is_error: false,
      });
      return;
    }

    if (isFinalTurn || hasFinalAnswerTag) {
      log.info('Finalizing agent session after max turns or final answer tag', {
        sessionId,
        subscriptionId: subscription.id,
        turns: session.turns,
        hasFinalAnswerTag,
      });

      pushToSessionHistory(logger, session, { role: 'assistant', content });
      await persistSessionToDB(sessionId, session);
      sessionMessages.delete(sessionId);
      send({
        session_id: sessionId,
        sender: 'agent',
        content: hasFinalAnswerTag ? content : `<final_answer>\n${content}\n</final_answer>`,
      });
    } else if (content) {
      // Fallback: the LLM returned content without any recognized tag and it
      // is not the final turn (e.g. plain-text conclusion after terminal
      // output). Treat it as a final answer so the client is never left
      // hanging.
      log.info('Agent returned untagged content on a non-final turn; treating as final answer', {
        sessionId,
        subscriptionId: subscription.id,
        turn: session.turns,
      });

      pushToSessionHistory(log, session, { role: 'assistant', content });
      await persistSessionToDB(sessionId, session);
      sessionMessages.delete(sessionId);
      send({
        session_id: sessionId,
        sender: 'agent',
        content: `<final_answer>\n${content}\n</final_answer>`,
      });
    } else {
      log.warn('Agent returned empty content with no recognized tags; sending error', {
        sessionId,
      });
      sendFinalAnswer(
        send,
        sessionId,
        'The agent returned an empty response. Please try again.',
        true,
      );
      // Evict from in-memory cache; DB record is preserved.
      sessionMessages.delete(sessionId);
    }
  } catch (err) {
    log.error('Agent LLM call failed', { error: err });
    const errorMessage = 'Agent failed to call language model. Please try again later.';
    sendFinalAnswer(send, sessionId, errorMessage, true);

    // Evict from in-memory cache; DB record is preserved so the user can
    // review or delete the session from the client.
    sessionMessages.delete(sessionId);
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
        log.debug('Received AgentMessage from client (WebSocket)', {
          sessionId,
          sender: message.sender,
          isTerminalOutput: message.is_terminal_output,
          isError: message.is_error,
        });

        void runAgentTurn(sessionId, subscription, message, send, log);
      })();
    });

    ws.on('error', (err) => {
      log.warn('Agent WebSocket error', { error: err });
    });

    ws.on('close', () => {
      log.info('Agent WebSocket connection closed', {
        hadAuthenticatedSubscription: Boolean(getSubscription()),
      });
    });
  });

  logger.info('Agent WebSocket server attached at path /ws/omni-agent');

  return wss;
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
          remainingContextTokens: Math.max(0, MAX_HISTORY_TOTAL - Number(s.totalTokensUsed)),
          contextBudget: MAX_HISTORY_TOTAL,
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

      // Also remove from the in-memory cache if it was loaded.
      sessionMessages.delete(sessionId);

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
        remainingContextTokens: Math.max(0, MAX_HISTORY_TOTAL - Number(session.totalTokensUsed)),
        contextBudget: MAX_HISTORY_TOTAL,
        lastActiveAt: session.lastActiveAt,
      });
    } catch (err) {
      log.error('Failed to fetch agent session context', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/:sessionId/messages
  // Returns a compact, human-readable transcript of the session history
  // (user + assistant turns only, internal XML tags stripped).
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

      type RawMessage = { role: string; content: unknown };
      const raw: RawMessage[] = JSON.parse(session.historyJson || '[]');

      // Strip / unwrap all internal XML-like tags used by the agent protocol.
      const stripInternals = (text: string): string =>
        text
          // Unwrap user input — keep the inner text, drop the tag.
          .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
          // Unwrap final answer — keep the inner text, drop the tag.
          .replace(/<final_answer>([\s\S]*?)<\/final_answer>/gi, '$1')
          // Replace shell script blocks with a placeholder.
          .replace(/<shell_script[\s\S]*?<\/shell_script>/gi, '[shell command]')
          // Drop stored instructions entirely — not meaningful to the user.
          .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
          // Drop terminal output blocks — shown separately on the client.
          .replace(/<terminal[\s\S]*?<\/terminal>/gi, '')
          // Drop the @omniAgent mention that triggers the agent.
          .replace(/@omniagent/gi, '')
          .trim();

      const messages = raw
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m, index) => {
          const rawText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          const cleaned = stripInternals(rawText);
          return {
            id: `${index}-${m.role}`,
            role: m.role as 'user' | 'assistant',
            text: cleaned,
          };
        })
        .filter((m) => m.text.length > 0);

      res.json({ messages });
    } catch (err) {
      log.error('Failed to fetch agent session messages', { sessionId, error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
