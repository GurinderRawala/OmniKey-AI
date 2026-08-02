import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import cuid from 'cuid';
import { logger } from '../../logger';
import { createLazyAuthContext } from '../agentAuth';
import type { AgentMessage, AgentSendFn } from '../types';
import type { Subscription } from '../../models/subscription';
import type { Logger } from 'winston';
import { activeSessions, pendingShellScripts, sessionQueues } from './runtimeState';
import {
  clearSteeringMessages,
  enqueueSteeringMessage,
  formatSteeringMessagesForQueuedTurn,
  getPendingSteeringMessageCount,
  takePendingSteeringMessages,
} from './steering';
import { buildShellToolResult } from './terminalOutput';
import { runAgentTurn } from './turnRunner';

export function queuePendingSteeringAsFollowUp(
  sessionId: string,
  subscription: Subscription,
  send: AgentSendFn,
  log: Logger,
): number {
  const pending = takePendingSteeringMessages(sessionId);
  if (!pending.length) return 0;

  const content = formatSteeringMessagesForQueuedTurn(pending);
  if (!content) return 0;
  const platform = pending.find((message) => message.platform)?.platform;
  const groupName = pending.find((message) => message.groupName)?.groupName;

  const queue = sessionQueues.get(sessionId) ?? [];
  queue.push({
    message: {
      session_id: sessionId,
      sender: 'client',
      content,
      platform,
      group_name: groupName,
    },
    send,
    subscription,
    log,
  });
  sessionQueues.set(sessionId, queue);

  log.info('Queued stranded steering as follow-up turn', {
    sessionId,
    steeringMessageCount: pending.length,
    queueLength: queue.length,
  });

  return pending.length;
}

async function processNextInQueue(sessionId: string): Promise<void> {
  const queue = sessionQueues.get(sessionId);
  if (!queue?.length) return;

  const next = queue.shift()!;
  if (!queue.length) sessionQueues.delete(sessionId);

  activeSessions.add(sessionId);
  try {
    await runAgentTurn(sessionId, next.subscription, next.message, next.send, next.log);
  } catch (err) {
    next.log.error('Queued agent turn failed', { sessionId, error: err });
  } finally {
    queuePendingSteeringAsFollowUp(sessionId, next.subscription, next.send, next.log);
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
        const isSteeringMessage = Boolean(message.is_steering);

        if (
          isSteeringMessage &&
          !isTerminalFeedback &&
          !isInternalCall &&
          activeSessions.has(sessionId)
        ) {
          const steeringResult = enqueueSteeringMessage(sessionId, message, log);
          if (!steeringResult.accepted) {
            send({
              session_id: sessionId,
              sender: 'agent',
              content: 'Empty steering update ignored.',
              is_terminal_output: false,
              is_error: true,
              is_steering: true,
            });
            log.info('Ignored empty steering message for active session', { sessionId });
            return;
          }

          send({
            session_id: sessionId,
            sender: 'agent',
            content: 'Steering update received for the running task.',
            is_terminal_output: false,
            is_error: false,
            is_steering: true,
          });
          log.info('Accepted steering message for active session', {
            sessionId,
            pendingSteeringMessages: steeringResult.pendingCount,
          });
          return;
        }

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
        const pendingShell = pendingShellScripts.get(sessionId);
        if (pendingShell && isTerminalFeedback) {
          pendingShellScripts.delete(sessionId);
          const content = buildShellToolResult(
            message.content ?? '',
            Boolean(message.is_error),
            pendingShell.filterKeywords,
          );
          log.info('Resolving pending shell_script tool result from terminal output', {
            sessionId,
            isError: Boolean(message.is_error),
            rawContentLength: (message.content ?? '').length,
            refinedContentLength: content.length,
          });
          pendingShell.resolve(content);
          return;
        }

        activeSessions.add(sessionId);
        try {
          await runAgentTurn(sessionId, subscription, message, send, log);
        } catch (err) {
          log.error('Agent turn failed', { sessionId, error: err });
        } finally {
          queuePendingSteeringAsFollowUp(sessionId, subscription, send, log);
          activeSessions.delete(sessionId);
          void processNextInQueue(sessionId);
        }
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
        const pendingShell = pendingShellScripts.get(sid);
        if (pendingShell) {
          pendingShellScripts.delete(sid);
          pendingShell.resolve(
            buildShellToolResult(
              'WebSocket connection closed before script output was received.',
              true,
              pendingShell.filterKeywords,
            ),
          );
          log.info('Resolved pending shell_script with disconnect error', { sessionId: sid });
        }
      }

      // A turn suspended inside runToolLoop waiting for shell_script terminal
      // output leaves the session in activeSessions until that turn unwinds,
      // which would make follow-up messages queue forever. Clean them up so a
      // reconnecting client can resume without being stuck.
      for (const sid of connectionSessionIds) {
        const wasActive = activeSessions.has(sid);
        const queueLength = sessionQueues.get(sid)?.length ?? 0;
        const steeringLength = getPendingSteeringMessageCount(sid);
        const drainedSteeringLength = wasActive ? 0 : clearSteeringMessages(sid);

        if (wasActive || queueLength > 0 || steeringLength > 0) {
          activeSessions.delete(sid);
          sessionQueues.delete(sid);
          log.info('Cleaned up stuck session state after WebSocket disconnect', {
            sessionId: sid,
            wasActive,
            drainedQueueLength: queueLength,
            drainedSteeringLength,
            retainedSteeringLength: wasActive ? steeringLength : 0,
          });
        }
      }

      // Per-session summaries and group descriptions are (re)generated by the
      // hourly grouping cron's single agent pass. We no longer make an extra
      // per-session LLM call on WebSocket close.
    });
  });

  logger.info('Agent WebSocket server attached at path /ws/omni-agent');

  return wss;
}
