import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import cuid from 'cuid';
import { config } from '../config';
import { logger } from '../logger';
import { Subscription } from '../models/subscription';
import { SubscriptionUsage } from '../models/subscriptionUsage';
import { getAgentPrompt } from './agentPrompts';
import { getPromptForCommand } from '../featureRoutes';
import { selfHostedSubscription } from '../authMiddleware';
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL, executeTool } from '../web-search-provider';
import { aiClient, AIMessage, AITool, AICompletionResult, getDefaultModel } from '../ai-client';

interface AgentMessage {
  session_id: string;
  sender: string;
  content: string;
  is_terminal_output?: boolean;
  is_error?: boolean;
  is_web_call?: boolean;
  platform?: string;
}

interface DecodedJwtPayload {
  sid: string;
}

// In-memory conversation state per session.
type SessionState = {
  subscription: Subscription;
  history: AIMessage[];
  // Number of agent turns that have been run for this session.
  turns: number;
};

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

    session.history.push(result.assistantMessage);
    log.info('Agent executing tool calls', {
      sessionId,
      turn: session.turns,
      toolIteration: toolIterations,
      tools: toolCalls.map((tc) => tc.name),
    });

    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        const args = tc.arguments as Record<string, string>;

        // Notify the frontend that a web tool call is about to execute.
        const webCallContent =
          tc.name === 'web_search'
            ? `Searching the web for: "${args.query ?? ''}"`
            : `Fetching URL: ${args.url ?? ''}`;
        send({
          session_id: sessionId,
          sender: 'agent',
          content: webCallContent,
          is_terminal_output: false,
          is_error: false,
          is_web_call: true,
        });

        const toolResult = await executeTool(tc.name, args, log);
        log.info('Tool call completed', {
          sessionId,
          tool: tc.name,
          resultLength: toolResult.length,
        });
        return { id: tc.id, name: tc.name, result: toolResult };
      }),
    );

    for (const { id, name, result: toolResult } of toolResults) {
      session.history.push({
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

    session.history.push(result.assistantMessage);
    session.history.push({
      role: 'user',
      content:
        'You have reached the maximum number of tool calls. Based on all the information gathered so far, provide a single, final, concise answer. Do not call any more tools.',
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

function buildAvailableTools(): AITool[] {
  // web_search is always available — DuckDuckGo is used as free fallback
  return [WEB_FETCH_TOOL, WEB_SEARCH_TOOL];
}

const aiModel = getDefaultModel(config.aiProvider, 'smart');

const sessionMessages = new Map<string, SessionState>();

type AgentSendFn = (msg: AgentMessage) => void;

const MAX_TURNS = 10;

async function getOrCreateSession(
  sessionId: string,
  subscription: Subscription,
  platform: string | undefined,
  log: typeof logger,
): Promise<{ sessionState: SessionState; hasStoredPrompt: boolean }> {
  const existing = sessionMessages.get(sessionId);
  if (existing) {
    log.debug('Reusing existing agent session', {
      sessionId,
      subscriptionId: existing.subscription.id,
      turns: existing.turns,
    });
    return {
      sessionState: existing,
      hasStoredPrompt: existing.history
        .filter((h) => h.role === 'user')
        .some((h) => h.content.includes('<stored_instructions>')),
    };
  }

  // use these instructions as user instructions
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
      ...(prompt
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

async function authenticateFromAuthHeader(
  authHeader: string | undefined,
  log: typeof logger,
): Promise<Subscription | null> {
  if (config.isSelfHosted) {
    log.info('Self-hosted mode: skipping JWT authentication for agent WebSocket connection.');
    try {
      const subscription = await selfHostedSubscription();
      log.info('Retrieved self-hosted subscription for agent WebSocket connection', {
        subscriptionId: subscription.id,
      });
      return subscription;
    } catch (err) {
      log.error('Failed to retrieve self-hosted subscription for agent WebSocket connection', {
        error: err,
      });
      return null;
    }
  }

  if (!config.jwtSecret) {
    log.error('JWT secret is not configured. Cannot authenticate subscription from auth header.');
    return null;
  }
  if (!authHeader) {
    log.warn('Agent WebSocket connection missing authorization header');
    return null;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    log.warn('Agent WebSocket connection has malformed authorization header');
    return null;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as DecodedJwtPayload;
    const subscription = await Subscription.findByPk(decoded.sid);

    if (!subscription) {
      log.warn('Agent WebSocket auth failed: subscription not found', {
        sid: decoded.sid,
      });
      return null;
    }

    if (subscription.subscriptionStatus === 'expired') {
      log.warn('Agent WebSocket auth failed: subscription expired', {
        sid: decoded.sid,
      });
      return null;
    }

    const now = new Date();
    if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
      subscription.subscriptionStatus = 'expired';
      await subscription.save();

      log.info('Agent WebSocket auth: subscription key expired during connection', {
        subscriptionId: subscription.id,
      });

      return null;
    }

    log.debug('Agent WebSocket auth succeeded', {
      subscriptionId: subscription.id,
      status: subscription.subscriptionStatus,
    });
    return subscription;
  } catch (err) {
    log.warn('Agent WebSocket auth failed: invalid or expired JWT', { error: err });
    return null;
  }
}

function createUserContent(content: string, hasStoredPrompt: boolean) {
  return hasStoredPrompt ? content.replace(/@omniAgent/g, '').trim() : content;
}

async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: typeof logger,
) {
  const { sessionState: session, hasStoredPrompt } = await getOrCreateSession(
    sessionId,
    subscription,
    clientMessage.platform,
    log,
  );

  // Count this call as one agent iteration.
  session.turns += 1;

  log.info('Starting agent turn', {
    sessionId,
    subscriptionId: subscription.id,
    turn: session.turns,
  });

  // On the MAX_TURNS iteration, instruct the LLM to provide a final,
  // consolidated answer based on the full conversation context.
  if (session.turns === MAX_TURNS) {
    session.history.push({
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
  });

  const isAssistance = isTerminalOutput || isErrorFlag;

  if (!clientMessage?.is_web_call) {
    session.history.push({
      role: 'user',
      content: isAssistance
        ? userContent
        : `<user_input>${createUserContent(userContent, hasStoredPrompt)}</user_input>`,
    });
  }

  // On the final turn we omit tools so the model is forced to emit a
  // plain text <final_answer> rather than issuing another tool call.
  const isFinalTurn = session.turns >= MAX_TURNS;
  const tools = isFinalTurn ? undefined : buildAvailableTools();

  const recordUsage = async (result: AICompletionResult) => {
    const usage = result.usage;
    if (!usage || !subscription.id) return;
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

      // Clear any cached session state so a subsequent attempt can
      // start fresh without a polluted history.
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

      result = await runToolLoop(
        result,
        session,
        sessionId,
        send,
        log,
        buildAvailableTools(),
        recordUsage,
      );
      content = result.content.trim();

      if (!content) {
        log.warn('Agent returned empty content after tool loop; sending generic error.');
        sendFinalAnswer(
          send,
          sessionId,
          'The agent returned an empty response. Please try again.',
          true,
        );
        sessionMessages.delete(sessionId);
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

      session.history.push({
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

      send({
        session_id: sessionId,
        sender: 'agent',
        content: hasFinalAnswerTag ? content : `<final_answer>\n${content}\n</final_answer>`,
      });
      sessionMessages.delete(sessionId);
    }
  } catch (err) {
    log.error('Agent LLM call failed', { error: err });
    const errorMessage = 'Agent failed to call language model. Please try again later.';
    sendFinalAnswer(send, sessionId, errorMessage, true);

    // Clear any cached session state so a subsequent attempt can
    // start fresh without being polluted by a failed turn.
    sessionMessages.delete(sessionId);
  }
}

function sendFinalAnswer(
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

type AuthContext = {
  ensureAuthenticated: () => Promise<boolean>;
  getSubscription: () => Subscription | null;
};

function createLazyAuthContext(authHeader: string | undefined, log: typeof logger): AuthContext {
  let authenticatedSubscription: Subscription | null = null;
  let authFailed = false;
  let authPromise: Promise<void> | null = null;

  const ensureAuthenticated = async (): Promise<boolean> => {
    if (authenticatedSubscription) {
      return true;
    }
    if (authFailed) {
      return false;
    }

    if (!authPromise) {
      authPromise = (async () => {
        try {
          const sub = await authenticateFromAuthHeader(authHeader, log);
          if (!sub) {
            authFailed = true;
            return;
          }
          authenticatedSubscription = sub;
          log.info('Agent WebSocket authenticated', {
            subscriptionId: authenticatedSubscription.id,
          });
        } catch (err) {
          authFailed = true;
          log.error('Unexpected error during agent WebSocket auth', { error: err });
        }
      })();
    }

    await authPromise;
    return Boolean(authenticatedSubscription);
  };

  const getSubscription = () => authenticatedSubscription;

  return { ensureAuthenticated, getSubscription };
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
