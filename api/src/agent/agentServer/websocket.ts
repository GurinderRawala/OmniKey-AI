import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import cuid from 'cuid';
import { logger } from '../../logger';
import { createLazyAuthContext } from '../agentAuth';
import type { AgentMessage, AgentSendFn } from '../types';
import type { Logger } from 'winston';
import {
  activeSessions,
  pendingShellScripts,
  sessionActiveSubscriptions,
  sessionQueues,
  sessionOwners,
  sessionSteeringIds,
} from './runtimeState';
import {
  enqueueSteeringMessage,
  takePendingSteeringMessages,
  MAX_STEERING_ID_LENGTH,
} from './steering';
import { isSessionIdAvailableTo, SESSION_UNAVAILABLE_MESSAGE } from './sessionStore';
import { buildShellToolResult } from './terminalOutput';
import { runAgentTurn } from './turnRunner';
import { handleGitDiffResponseFrame } from '../gitDiff/coordinator';

export function rejectPendingSteeringAtTurnEnd(
  sessionId: string,
  send: AgentSendFn,
  log: Logger,
): number {
  const pending = takePendingSteeringMessages(sessionId, log);
  if (!pending.length) return 0;

  // Late rejection goes to the steering sender, like its received ack.
  for (const message of pending) {
    (message.replyTo ?? send)({
      session_id: sessionId,
      sender: 'agent',
      content:
        'The current task finished before this update was applied. Send it again as a follow-up.',
      is_terminal_output: false,
      is_error: true,
      is_steering: true,
      steering_id: message.steeringId,
      steering_status: 'rejected',
    });
  }

  log.info('Rejected steering that arrived too late for the active turn', {
    sessionId,
    steeringMessageCount: pending.length,
  });

  return pending.length;
}

async function processNextInQueue(sessionId: string): Promise<void> {
  if (activeSessions.has(sessionId)) return;
  const queue = sessionQueues.get(sessionId);
  if (!queue?.length) return;

  const next = queue.shift()!;
  if (!queue.length) sessionQueues.delete(sessionId);

  if (next.signal?.aborted) {
    void processNextInQueue(sessionId);
    return;
  }
  activeSessions.add(sessionId);
  if (next.signal) sessionOwners.set(sessionId, next.signal);
  const runOwner = { subscriptionId: next.subscription.id };
  sessionActiveSubscriptions.set(sessionId, runOwner);
  const runSteeringIds = new Set<string>();
  sessionSteeringIds.set(sessionId, runSteeringIds);
  try {
    await runAgentTurn(sessionId, next.subscription, next.message, next.send, next.log, {
      signal: next.signal,
      interactiveInput: true,
      // Capability of the connection that sent (and receives frames for) this input.
      supportsSkillStatus: next.message.supports_skill_status === true,
      supportsGitDiff: next.message.supports_git_diff === true,
      supportsGitTurnDiff: next.message.supports_git_turn_diff === true,
      supportsDiffRecovery: next.message.supports_diff_recovery === true,
    });
  } catch (err) {
    next.log.error('Queued agent turn failed', { sessionId, error: err });
  } finally {
    rejectPendingSteeringAtTurnEnd(sessionId, next.send, next.log);
    if (sessionSteeringIds.get(sessionId) === runSteeringIds) sessionSteeringIds.delete(sessionId);
    if (sessionActiveSubscriptions.get(sessionId) === runOwner) {
      sessionActiveSubscriptions.delete(sessionId);
    }
    sessionOwners.delete(sessionId);
    activeSessions.delete(sessionId);
    void processNextInQueue(sessionId);
  }
}

export function attachAgentWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/omni-agent' });

  wss.on('connection', (ws: WebSocket, req) => {
    const connection = new AbortController();
    const traceId = cuid();
    const log = logger.child({ traceId });

    log.info('Agent WebSocket connection opened');

    const authHeaderValue = req.headers['authorization'];
    const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;

    const { ensureAuthenticated, getSubscription } = createLazyAuthContext(authHeader, log);

    const send: AgentSendFn = (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        log.error('Failed to write AgentMessage to WebSocket', { error: err });
      }
    };

    // Track session IDs touched by this connection so we can clean up on close.
    const connectionSessionIds = new Set<string>();

    // Messages of one connection are admitted (ownership-checked, then queued,
    // steered or resolved) strictly in arrival order, even though the ownership
    // check is asynchronous. Only admission is serialized, never a whole turn.
    let admissionTail: Promise<void> = Promise.resolve();

    // Resolves once the message is admitted. Never waits for a turn to finish.
    const admitMessage = async (data: WebSocket.RawData): Promise<void> => {
      const ok = await ensureAuthenticated();
      const subscription = getSubscription();
      if (connection.signal.aborted) return;

      if (!ok || !subscription) {
        if (ws.readyState === WebSocket.OPEN) {
          log.warn('Closing Agent WebSocket due to failed authentication');
          send({
            session_id: '',
            sender: 'agent',
            content: 'Unauthorized: missing or invalid subscription. Please re-activate your key.',
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

      // A Git snapshot reply settles only its own outstanding capture (same
      // request id, session, subscription and connection). It is never a
      // turn input, steering, terminal feedback or model message.
      if (handleGitDiffResponseFrame(message, subscription.id, connection.signal, log)) return;

      const sessionId = message.session_id || 'default';
      connectionSessionIds.add(sessionId);
      log.debug('Received AgentMessage from client (WebSocket)', {
        sessionId,
        sender: message.sender,
        isTerminalOutput: message.is_terminal_output,
        isError: message.is_error,
      });

      // Only terminal feedback can resolve work within an active turn. All
      // other wire messages share the session queue, including web callbacks.
      const isTerminalFeedback = Boolean(message.is_terminal_output) || Boolean(message.is_error);
      const isInternalCall = Boolean(message.is_web_call);
      const isSteeringMessage = Boolean(message.is_steering);
      const isTurnInput = !isTerminalFeedback && !(isSteeringMessage && !isInternalCall);
      // Feedback with no active turn falls through to start a new turn.
      const mayStartTurn = isTurnInput || (isTerminalFeedback && !activeSessions.has(sessionId));

      // Ownership before the queue: a message for an id stored under another
      // subscription (or whose lookup fails) never queues, marks the session
      // active, resolves Skills or reaches a model. An unused id stays
      // claimable; getOrCreateSession settles creation races fail closed.
      if (mayStartTurn) {
        const available = await isSessionIdAvailableTo(sessionId, subscription.id, log);
        if (connection.signal.aborted) return;
        if (!available) {
          send({
            session_id: sessionId,
            sender: 'agent',
            content: SESSION_UNAVAILABLE_MESSAGE,
            is_terminal_output: false,
            is_error: true,
          });
          return;
        }
      }

      // A run is owned by the authenticated subscription that started it.
      // Another subscription may not steer or feed back into it. Rejections
      // reuse fixed frames and carry no owner/skill details; other
      // connections of the same subscription are unaffected. A turn input
      // that passed the ownership check above is not rejected here: the
      // other run is then an unproven claim (refused when its session
      // loads), so the input queues behind it in FIFO order.
      const activeOwner = activeSessions.has(sessionId)
        ? sessionActiveSubscriptions.get(sessionId)
        : undefined;
      if (activeOwner && activeOwner.subscriptionId !== subscription.id && !isTurnInput) {
        log.warn('Rejected message for a session run owned by another subscription', {
          sessionId,
        });
        if (isTerminalFeedback) return;
        send({
          session_id: sessionId,
          sender: 'agent',
          content:
            'The current task finished before this update could be queued. Send it again as a follow-up.',
          is_terminal_output: false,
          is_error: true,
          is_steering: true,
          steering_id:
            typeof message.steering_id === 'string' &&
            message.steering_id.length <= MAX_STEERING_ID_LENGTH
              ? message.steering_id
              : undefined,
          steering_status: 'rejected',
          steering_pending_count: 0,
        });
        return;
      }

      if (isSteeringMessage && !isTerminalFeedback && !isInternalCall) {
        if (!activeSessions.has(sessionId) || sessionOwners.get(sessionId)?.aborted) {
          send({
            session_id: sessionId,
            sender: 'agent',
            content:
              'The current task finished before this update could be queued. Send it again as a follow-up.',
            is_terminal_output: false,
            is_error: true,
            is_steering: true,
            steering_id:
              typeof message.steering_id === 'string' &&
              message.steering_id.length <= MAX_STEERING_ID_LENGTH
                ? message.steering_id
                : undefined,
            steering_status: 'rejected',
            steering_pending_count: 0,
          });
          return;
        }

        const steeringResult = enqueueSteeringMessage(sessionId, message, log, send);
        if (steeringResult.duplicate) return;
        if (!steeringResult.accepted) {
          send({
            session_id: sessionId,
            sender: 'agent',
            content: steeringResult.rejectionReason ?? 'Empty steering update ignored.',
            is_terminal_output: false,
            is_error: true,
            is_steering: true,
            steering_id:
              typeof message.steering_id === 'string' &&
              message.steering_id.length <= MAX_STEERING_ID_LENGTH
                ? message.steering_id
                : undefined,
            steering_status: 'rejected',
            steering_pending_count: steeringResult.pendingCount,
          });
          log.info('Ignored steering message for active session', {
            sessionId,
            reason: steeringResult.rejectionReason ?? 'empty',
            pendingSteeringMessages: steeringResult.pendingCount,
          });
          return;
        }

        send({
          session_id: sessionId,
          sender: 'agent',
          content: 'Steering update received for the running task.',
          is_terminal_output: false,
          is_error: false,
          is_steering: true,
          steering_id:
            typeof message.steering_id === 'string' &&
            message.steering_id.length <= MAX_STEERING_ID_LENGTH
              ? message.steering_id
              : undefined,
          steering_status: 'received',
          steering_pending_count: steeringResult.pendingCount,
        });
        log.info('Accepted steering message for active session', {
          sessionId,
          pendingSteeringMessages: steeringResult.pendingCount,
        });
        return;
      }

      if (!isTerminalFeedback && activeSessions.has(sessionId)) {
        // A turn is already running for this session. Queue the message so it
        // is processed in order once the current turn completes.
        const queue = sessionQueues.get(sessionId) ?? [];
        queue.push({ message, send, subscription, log, signal: connection.signal });
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
      if (
        isTerminalFeedback &&
        activeSessions.has(sessionId) &&
        sessionOwners.get(sessionId) !== connection.signal
      ) {
        log.warn('Ignored terminal feedback from a connection that does not own the turn', {
          sessionId,
        });
        return;
      }
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
        const isError = typeof message.is_error === 'boolean' ? message.is_error : undefined;
        // Raw observations are validated by the tool loop against the exact
        // shell request it issued; absent for clients without Git support.
        if (message.diff_recovery_evidence !== undefined) {
          pendingShell.resolve(
            content,
            isError,
            message.git_commit_observations,
            message.diff_recovery_evidence,
          );
        } else if (message.git_commit_observations === undefined) {
          pendingShell.resolve(content, isError);
        } else {
          pendingShell.resolve(content, isError, message.git_commit_observations);
        }
        return;
      }

      // Late feedback must not start another turn while its owner is running.
      if (isTerminalFeedback && activeSessions.has(sessionId)) return;
      const queue = sessionQueues.get(sessionId) ?? [];
      queue.push({ message, send, subscription, log, signal: connection.signal });
      sessionQueues.set(sessionId, queue);
      // Marks the session active synchronously; the turn itself is not awaited
      // so the next message's admission is not held behind it.
      void processNextInQueue(sessionId);
    };

    ws.on('message', (data) => {
      const priorAdmission = admissionTail;
      let releaseAdmission!: () => void;
      admissionTail = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      void (async () => {
        try {
          await priorAdmission;
          await admitMessage(data);
        } catch (err) {
          log.error('Failed to admit Agent WebSocket message', { error: err });
        } finally {
          releaseAdmission();
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

      // Cancellation settles an owned shell wait and aborts provider requests.
      // Keep the active lock until the turn has saved its checkpoint and exited;
      // otherwise a reconnect can race an old turn's writes.
      connection.abort();
      for (const sid of connectionSessionIds) {
        const queue = sessionQueues.get(sid)?.filter((item) => item.signal !== connection.signal);
        if (queue?.length) sessionQueues.set(sid, queue);
        else sessionQueues.delete(sid);
      }

      // Per-session summaries and group descriptions are (re)generated by the
      // hourly grouping cron's single agent pass. We no longer make an extra
      // per-session LLM call on WebSocket close.
    });
  });

  logger.info('Agent WebSocket server attached at path /ws/omni-agent');

  return wss;
}
