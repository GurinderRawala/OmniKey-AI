import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import { config } from './config';
import { logger } from './logger';
import { Subscription } from './models/subscription';
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
const sessionMessages = new Map<
  string,
  {
    subscription: Subscription;
    history: AgentChatMessage[];
  }
>();

function getOrCreateSession(
  sessionId: string,
  subscription: Subscription,
): {
  subscription: Subscription;
  history: AgentChatMessage[];
} {
  const existing = sessionMessages.get(sessionId);
  if (existing) return existing;

  const entry: { subscription: Subscription; history: AgentChatMessage[] } = {
    subscription,
    history: [
      {
        role: 'system',
        content: AGENT_SYSTEM_PROMPT,
      },
    ],
  };

  sessionMessages.set(sessionId, entry);
  return entry;
}

async function authenticateCall(
  call: grpc.ServerDuplexStream<AgentMessage, AgentMessage>,
): Promise<Subscription | null> {
  const metadata = call.metadata;
  const authHeader = metadata.get('authorization')[0] as string | undefined;

  if (!authHeader) {
    logger.warn('Agent gRPC call missing authorization metadata');
    return null;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    logger.warn('Agent gRPC call has malformed authorization metadata');
    return null;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as DecodedJwtPayload;
    const subscription = await Subscription.findByPk(decoded.sid);

    if (!subscription) {
      logger.warn('Agent gRPC auth failed: subscription not found', {
        sid: decoded.sid,
      });
      return null;
    }

    if (subscription.subscriptionStatus === 'expired') {
      logger.warn('Agent gRPC auth failed: subscription expired', {
        sid: decoded.sid,
      });
      return null;
    }

    const now = new Date();
    if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
      subscription.subscriptionStatus = 'expired';
      await subscription.save();

      logger.info('Agent gRPC auth: subscription key expired during call', {
        subscriptionId: subscription.id,
      });

      return null;
    }

    return subscription;
  } catch (err) {
    logger.warn('Agent gRPC auth failed: invalid or expired JWT', { error: err });
    return null;
  }
}

async function runAgentTurn(
  sessionId: string,
  subscription: Subscription,
  clientMessage: AgentMessage,
  send: (msg: AgentMessage) => void,
) {
  const session = getOrCreateSession(sessionId, subscription);

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
    logger.warn('OPENAI_API_KEY is not set; skipping agent turn.');
    return;
  }

  try {
    const systemPrompt = await getSystemPromptForCommand(logger, 'task', subscription);

    session.history.push({
      role: 'system',
      content: [systemPrompt, AGENT_SYSTEM_PROMPT].filter(Boolean).join('\n'),
    });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.1',
      // The OpenAI client accepts a superset of this simple
      // message shape; we safely cast here to keep our local
      // types minimal.
      messages: session.history as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: 0.2,
    });

    const choice = completion.choices[0];
    const content = (choice.message.content ?? '').toString().trim();

    if (!content) {
      logger.warn('Agent LLM returned empty content.');
      return;
    }

    // Record assistant message back into history for future turns.
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
  } catch (err) {
    logger.error('Agent LLM call failed', { error: err });
    send({
      session_id: sessionId,
      sender: 'agent',
      content: 'Agent failed to call language model. Please try again later.',
      is_terminal_output: false,
      is_error: true,
    });
  }
}

function agentStreamHandler(call: grpc.ServerDuplexStream<AgentMessage, AgentMessage>) {
  let authenticatedSubscription: Subscription | null = null;

  const send = (msg: AgentMessage) => {
    try {
      call.write(msg);
    } catch (err) {
      logger.error('Failed to write AgentMessage to stream', { error: err });
    }
  };

  authenticateCall(call)
    .then((sub) => {
      authenticatedSubscription = sub;
      if (!sub) {
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

      call.on('data', (message: AgentMessage) => {
        if (!authenticatedSubscription) {
          return;
        }

        const sessionId = message.session_id || 'default';
        void runAgentTurn(sessionId, authenticatedSubscription!, message, send);
      });

      call.on('error', (err: grpc.StatusObject) => {
        logger.warn('AgentStream call error', { error: err });
      });

      call.on('end', () => {
        call.end();
      });
    })
    .catch((err) => {
      logger.error('Unexpected error during agent stream auth', { error: err });
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
