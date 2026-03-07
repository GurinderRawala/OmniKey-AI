import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import cuid from 'cuid';
import { config } from './config';
import { logger } from './logger';
import { Subscription } from './models/subscription';
import { SubscriptionUsage } from './models/subscriptionUsage';
import { AGENT_SYSTEM_PROMPT } from './agentPrompts';
import { getSystemPromptForCommand } from './featureRoutes';

const PROTO_PATH = path.join(process.cwd(), 'proto', 'agent.proto');

type ProtoGrpcType = any; // kept loose to avoid over-typing dynamic loader

interface AgentMessage {
  session_id: string;
  sender: string;
  content: string;
  is_terminal_output?: boolean;
  is_error?: boolean;
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

async function getOrCreateSession(
  sessionId: string,
  subscription: Subscription,
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

  const systemPrompt = await getSystemPromptForCommand(log, 'task', subscription).catch((err) => {
    log.error('Failed to get system prompt for new agent session', { error: err });
    return '';
  });

  const entry: SessionState = {
    subscription,
    history: [
      {
        role: 'system',
        content: [systemPrompt, AGENT_SYSTEM_PROMPT].filter(Boolean).join('\n'),
      },
    ],
    turns: 0,
  };

  sessionMessages.set(sessionId, entry);
  log.info('Created new agent session', {
    sessionId,
    subscriptionId: subscription.id,
    hasCustomSystemPrompt: Boolean(systemPrompt),
  });
  return entry;
}

async function authenticateCall(
  call: grpc.ServerDuplexStream<AgentMessage, AgentMessage>,
  log: typeof logger,
): Promise<Subscription | null> {
  const metadata = call.metadata;
  const authHeader = metadata.get('authorization')[0] as string | undefined;

  if (!authHeader) {
    log.warn('Agent gRPC call missing authorization metadata');
    return null;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    log.warn('Agent gRPC call has malformed authorization metadata');
    return null;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as DecodedJwtPayload;
    const subscription = await Subscription.findByPk(decoded.sid);

    if (!subscription) {
      log.warn('Agent gRPC auth failed: subscription not found', {
        sid: decoded.sid,
      });
      return null;
    }

    if (subscription.subscriptionStatus === 'expired') {
      log.warn('Agent gRPC auth failed: subscription expired', {
        sid: decoded.sid,
      });
      return null;
    }

    const now = new Date();
    if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
      subscription.subscriptionStatus = 'expired';
      await subscription.save();

      log.info('Agent gRPC auth: subscription key expired during call', {
        subscriptionId: subscription.id,
      });

      return null;
    }

    log.debug('Agent gRPC auth succeeded', {
      subscriptionId: subscription.id,
      status: subscription.subscriptionStatus,
    });
    return subscription;
  } catch (err) {
    log.warn('Agent gRPC auth failed: invalid or expired JWT', { error: err });
    return null;
  }
}

async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: (msg: AgentMessage) => void,
  log: typeof logger,
) {
  const session = await getOrCreateSession(sessionId, subscription, log);

  // Count this call as one agent iteration.
  session.turns += 1;

  log.info('Starting agent turn', {
    sessionId,
    subscriptionId: subscription.id,
    turn: session.turns,
  });

  // On the 5th iteration, instruct the LLM to provide a final,
  // consolidated answer based on the full conversation context.
  if (session.turns === 5) {
    session.history.push({
      role: 'system',
      content:
        'Provide a single, final, concise answer based on the entire conversation so far. Wrap the answer in a <final_answer>...</final_answer> block and do not ask for further input or mention additional shell scripts to run. Do not include any <shell_script> block in this response.',
    });
  }

  // Append the client message as user content, marking terminal
  // output and errors in the text so the agent can reason about them.
  let userContent = clientMessage.content || '';
  if (clientMessage.is_terminal_output) {
    userContent = `TERMINAL OUTPUT:\n${userContent}`;
  }
  if (clientMessage.is_error) {
    userContent = `COMMAND ERROR:\n${userContent}`;
  }

  session.history.push({
    role: 'user',
    content: userContent,
  });

  if (!config.openaiApiKey) {
    log.warn('OPENAI_API_KEY is not set; skipping agent turn.');
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
      log.warn('Agent LLM returned empty content.');
      return;
    }

    // Ensure that a proper <final_answer> block is produced for the
    // desktop clients once we reach the final turn. If the model did
    // not emit either a <shell_script> or <final_answer> tag on the
    // 5th turn, we treat this as the final natural-language answer
    // and wrap it in <final_answer> tags so the client can stop
    // waiting and paste the result.
    const hasShellScriptTag = content.includes('<shell_script>');
    const hasFinalAnswerTag = content.includes('<final_answer>');

    const normalizedContent =
      !hasShellScriptTag && !hasFinalAnswerTag && session.turns >= 5
        ? `<final_answer>\n${content}\n</final_answer>`
        : content;

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

    // After the 5th iteration or if a final answer tag is present, treat this as the final answer
    // and clear the session from memory while marking it completed.
    if (session.turns >= 5 || hasFinalAnswerTag) {
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
    send({
      session_id: sessionId,
      sender: 'agent',
      content: `<final_answer>\n${errorMessage}\n</final_answer>`,
      is_terminal_output: false,
      is_error: true,
    });

    // Clear any cached session state so a subsequent attempt can
    // start fresh without being polluted by a failed turn.
    sessionMessages.delete(sessionId);
  }
}

function agentStreamHandler(call: grpc.ServerDuplexStream<AgentMessage, AgentMessage>) {
  let authenticatedSubscription: Subscription | null = null;
  const traceId = cuid();

  const log = logger.child({ traceId });

  log.info('AgentStream connection opened');

  const send = (msg: AgentMessage) => {
    try {
      call.write(msg);
    } catch (err) {
      log.error('Failed to write AgentMessage to stream', { error: err });
    }
  };

  authenticateCall(call, log)
    .then((sub) => {
      authenticatedSubscription = sub;
      if (!sub) {
        log.warn('Closing AgentStream due to failed authentication');
        send({
          session_id: '',
          sender: 'agent',
          content: 'Unauthorized: missing or invalid subscription. Please re-activate your key.',
          is_terminal_output: false,
          is_error: true,
        });
        call.end();
        return;
      }

      log.info('AgentStream authenticated', {
        subscriptionId: authenticatedSubscription?.id,
      });

      call.on('data', (message: AgentMessage) => {
        if (!authenticatedSubscription) {
          return;
        }

        const sessionId = message.session_id || 'default';
        log.debug('Received AgentMessage from client', {
          sessionId,
          sender: message.sender,
          isTerminalOutput: message.is_terminal_output,
          isError: message.is_error,
        });
        void runAgentTurn(sessionId, authenticatedSubscription!, message, send, log);
      });

      call.on('error', (err: grpc.StatusObject) => {
        log.warn('AgentStream call error', { error: err });
      });

      call.on('end', () => {
        log.info('AgentStream ended by client', {
          hadAuthenticatedSubscription: Boolean(authenticatedSubscription),
        });
        call.end();
      });
    })
    .catch((err) => {
      log.error('Unexpected error during agent stream auth', { error: err });
      call.end();
    });
}

export function startAgentGrpcServer(): grpc.Server | null {
  const agentPort = process.env.AGENT_GRPC_PORT || '50051';

  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as ProtoGrpcType;

  if (!proto.omnikey || !proto.omnikey.AgentService) {
    logger.error('Failed to load AgentService from agent.proto');
    return null;
  }

  const server = new grpc.Server();

  server.addService(proto.omnikey.AgentService.service, {
    AgentStream: agentStreamHandler,
  });

  const bindAddress = `0.0.0.0:${agentPort}`;

  server.bindAsync(
    bindAddress,
    grpc.ServerCredentials.createInsecure(),
    (err: Error | null, port: number) => {
      if (err) {
        logger.error('Failed to start Agent gRPC server', { error: err });
        return;
      }
      logger.info(`Agent gRPC server listening on ${bindAddress} (bound port ${port})`);
      server.start();
    },
  );

  return server;
}
