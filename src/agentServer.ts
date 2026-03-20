import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import cuid from 'cuid';
import { config } from './config';
import { logger } from './logger';
import { Subscription } from './models/subscription';
import { SubscriptionUsage } from './models/subscriptionUsage';
import { AGENT_SYSTEM_PROMPT_MACOS, AGENT_SYSTEM_PROMPT_WINDOWS } from './agentPrompts';
import { getPromptForCommand } from './featureRoutes';
import { selfHostedSubscription } from './authMiddleware';

interface AgentMessage {
  session_id: string;
  sender: string;
  content: string;
  is_terminal_output?: boolean;
  is_error?: boolean;
  platform?: string;
}

interface DecodedJwtPayload {
  sid: string;
}

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

// Simple chat message type used for the in-memory conversation state.
type AgentChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// In-memory conversation state per session.
type SessionState = {
  subscription: Subscription;
  history: AgentChatMessage[];
  // Number of agent turns that have been run for this session.
  turns: number;
};

const sessionMessages = new Map<string, SessionState>();

type AgentSendFn = (msg: AgentMessage) => void;

const MAX_TURNS = 10;

async function getOrCreateSession(
  sessionId: string,
  subscription: Subscription,
  platform: string | undefined,
  log: typeof logger,
): Promise<SessionState> {
  const existing = sessionMessages.get(sessionId);
  if (existing) {
    log.debug('Reusing existing agent session', {
      sessionId,
      subscriptionId: existing.subscription.id,
      turns: existing.turns,
    });
    return existing;
  }

  const systemPrompt =
    platform === 'windows' ? AGENT_SYSTEM_PROMPT_WINDOWS : AGENT_SYSTEM_PROMPT_MACOS;

  // use these instructions as user instructions
  const prompt = await getPromptForCommand(log, 'task', subscription).catch((err) => {
    log.error('Failed to get system prompt for new agent session', { error: err });
    return '';
  });

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
              role: 'assistant' as const,
              content: `<user_configured_instructions>
# User-Configured Task Instructions
${prompt}
</user_configured_instructions>`,
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
  return entry;
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

async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: AgentSendFn,
  log: typeof logger,
) {
  const session = await getOrCreateSession(sessionId, subscription, clientMessage.platform, log);

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

  session.history.push({
    role: 'user',
    content: userContent,
  });

  if (!config.openaiApiKey) {
    log.warn('OPENAI_API_KEY is not set; returning error to client.');

    const errorMessage =
      'The server is missing its OpenAI API key. Please configure OPENAI_API_KEY on the backend and try again.';

    send({
      session_id: sessionId,
      sender: 'agent',
      content: `<final_answer>\n${errorMessage}\n</final_answer>`,
      is_terminal_output: false,
      is_error: true,
    });

    // Clear any cached session state so a subsequent attempt can
    // start fresh once the environment is correctly configured.
    sessionMessages.delete(sessionId);
    return;
  }

  try {
    log.debug('Calling OpenAI for agent turn', {
      sessionId,
      turn: session.turns,
      historyLength: session.history.length,
    });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.1',
      // The OpenAI client accepts a superset of this simple
      // message shape; we safely cast here to keep our local
      // types minimal.
      messages: session.history as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: 0.2,
    });

    // Record token usage for this subscription and model, if usage
    // data is available and we know which subscription made the call.
    const usage = completion.usage;
    if (usage && subscription.id) {
      try {
        await SubscriptionUsage.create({
          subscriptionId: subscription.id,
          model: completion.model ?? 'gpt-5.1',
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        });

        await Subscription.increment('totalTokensUsed', {
          by: usage.total_tokens ?? 0,
          where: { id: subscription.id },
        });
      } catch (err) {
        log.error('Failed to record subscription usage metrics for agent.', {
          error: err,
          subscriptionId: subscription.id,
        });
      }
    }

    const choice = completion.choices[0];
    const content = (choice.message.content ?? '').toString().trim();

    if (!content) {
      log.warn('Agent LLM returned empty content; sending generic error to client.');

      const errorMessage = 'The agent returned an empty response. Please try again.';

      sendFinalAnswer(send, sessionId, errorMessage, true);

      // Clear any cached session state so a subsequent attempt can
      // start fresh without a polluted history.
      sessionMessages.delete(sessionId);
      return;
    }

    // Ensure that a proper <final_answer> block is produced for the
    // desktop clients once we reach the final turn. If the model did
    // not emit either a <shell_script> or <final_answer> tag on the
    // MAX_TURNS turn, we treat this as the final natural-language answer
    // and wrap it in <final_answer> tags so the client can stop
    // waiting and paste the result.
    const hasShellScriptTag = content.includes('<shell_script>');
    const hasFinalAnswerTag = content.includes('<final_answer>');

    log.info('Agent LLM raw response summary', {
      sessionId,
      turn: session.turns,
      rawContentLength: content.length,
      hasShellScriptTag,
      hasFinalAnswerTag,
    });

    const normalizedContent =
      !hasShellScriptTag && !hasFinalAnswerTag && session.turns >= MAX_TURNS
        ? `<final_answer>\n${content}\n</final_answer>`
        : content;

    log.info('Agent LLM normalized response summary', {
      sessionId,
      turn: session.turns,
      normalizedContentLength: normalizedContent.length,
    });

    // Record assistant message back into history for future turns.
    session.history.push({
      role: 'assistant',
      content: normalizedContent,
    });

    send({
      session_id: sessionId,
      sender: 'agent',
      content: normalizedContent,
      is_terminal_output: false,
      is_error: false,
    });

    // After the MAX_TURNS iteration or if a final answer tag is present, treat this as the final answer
    // and clear the session from memory while marking it completed.
    if (session.turns >= MAX_TURNS || hasFinalAnswerTag) {
      log.info('Finalizing agent session after max turns or final answer tag', {
        sessionId,
        subscriptionId: subscription.id,
        turns: session.turns,
        hasFinalAnswerTag,
      });
      sessionMessages.delete(sessionId);
    }

    log.info('Completed agent turn', {
      sessionId,
      subscriptionId: subscription.id,
      turn: session.turns,
      responseLength: normalizedContent.length,
    });
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
