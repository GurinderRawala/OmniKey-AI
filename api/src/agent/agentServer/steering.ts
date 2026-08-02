import type { Logger } from 'winston';
import { pushToSessionHistory, createUserContent } from '../utils';
import type { AgentMessage, AgentSendFn, SessionState } from '../types';
import type { PendingSteeringMessage } from './serverTypes';
import { sessionSteeringMessages } from './runtimeState';

export const MAX_STEERING_RESTARTS = 8;
export const MAX_PENDING_STEERING_MESSAGES = 8;
export const MAX_PENDING_STEERING_CONTENT_CHARS = 16_000;
export const STEERING_MESSAGE_TTL_MS = 30 * 60 * 1000;
export const STEERING_RESTART_LIMIT_MESSAGE =
  'The agent received too many steering updates before it could make progress. The work so far has been saved; please send one consolidated follow-up.';

export interface EnqueueSteeringResult {
  accepted: boolean;
  pendingCount: number;
  rejectionReason?: string;
}

export interface SteeringRestartBudget {
  used: number;
  max: number;
}

function normalizeSteeringContent(content: string): string {
  return content.trim();
}

function totalPendingContentLength(messages: PendingSteeringMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function isFreshSteeringMessage(message: PendingSteeringMessage, now = Date.now()): boolean {
  const receivedAt = Date.parse(message.receivedAt);
  if (!Number.isFinite(receivedAt)) return false;
  return now - receivedAt <= STEERING_MESSAGE_TTL_MS;
}

function freshPendingSteeringMessages(
  sessionId: string,
  log: Logger,
): PendingSteeringMessage[] {
  const pending = sessionSteeringMessages.get(sessionId) ?? [];
  const fresh = pending.filter((message) => isFreshSteeringMessage(message));
  const discarded = pending.length - fresh.length;
  if (discarded > 0) {
    log.info('Discarded expired steering messages', {
      sessionId,
      discardedSteeringMessages: discarded,
      retainedSteeringMessages: fresh.length,
    });
  }
  return fresh;
}

export function createSteeringRestartBudget(initialUsed = 0): SteeringRestartBudget {
  return { used: initialUsed, max: MAX_STEERING_RESTARTS };
}

export function consumeSteeringRestart(
  budget: SteeringRestartBudget,
  sessionId: string,
  log: Logger,
  reason: string,
): boolean {
  if (budget.used >= budget.max) {
    log.warn('Steering restart limit reached; stopping turn', {
      sessionId,
      reason,
      steeringRestartsUsed: budget.used,
      maxSteeringRestarts: budget.max,
    });
    return false;
  }

  budget.used += 1;
  return true;
}

function formatSteeringBody(messages: Array<{ content: string; receivedAt: string }>): string {
  if (messages.length === 1) return messages[0].content;

  return messages
    .map((message, index) =>
      [`Update ${index + 1} (${message.receivedAt}):`, message.content].join('\n'),
    )
    .join('\n\n');
}

function formatSteeringContent(messages: Array<{ content: string; receivedAt: string }>): string {
  const body = formatSteeringBody(messages);

  return [
    '<user_steering priority="current_turn" semantics="newer_user_guidance">',
    body,
    '</user_steering>',
  ].join('\n');
}

export function formatSteeringMessagesForQueuedTurn(messages: PendingSteeringMessage[]): string {
  return formatSteeringBody(messages).trim();
}

export function enqueueSteeringMessage(
  sessionId: string,
  message: AgentMessage,
  log: Logger,
): EnqueueSteeringResult {
  const content = normalizeSteeringContent(message.content ?? '');
  if (!content) {
    return { accepted: false, pendingCount: sessionSteeringMessages.get(sessionId)?.length ?? 0 };
  }

  const pending = freshPendingSteeringMessages(sessionId, log);
  if (pending.length > 0) {
    sessionSteeringMessages.set(sessionId, pending);
  } else {
    sessionSteeringMessages.delete(sessionId);
  }

  if (pending.length >= MAX_PENDING_STEERING_MESSAGES) {
    return {
      accepted: false,
      pendingCount: pending.length,
      rejectionReason:
        'Too many steering updates are already pending for the running task. Wait for the agent to apply them, then send a consolidated update if needed.',
    };
  }

  const nextContentLength = totalPendingContentLength(pending) + content.length;
  if (nextContentLength > MAX_PENDING_STEERING_CONTENT_CHARS) {
    return {
      accepted: false,
      pendingCount: pending.length,
      rejectionReason:
        'Pending steering updates are too large for the running task. Wait for the agent to apply the current guidance, then send a shorter update.',
    };
  }

  pending.push({
    content,
    platform: message.platform,
    groupName: message.group_name,
    receivedAt: new Date().toISOString(),
  });
  sessionSteeringMessages.set(sessionId, pending);

  log.info('Queued steering message for active agent turn', {
    sessionId,
    pendingSteeringMessages: pending.length,
    contentLength: content.length,
  });

  return { accepted: true, pendingCount: pending.length };
}

export function drainSteeringMessagesIntoHistory(
  sessionId: string,
  session: SessionState,
  hasStoredPrompt: boolean,
  log: Logger,
): number {
  const existingPendingCount = sessionSteeringMessages.get(sessionId)?.length ?? 0;
  const pending = freshPendingSteeringMessages(sessionId, log);
  if (!pending?.length) {
    if (existingPendingCount > 0) sessionSteeringMessages.delete(sessionId);
    return 0;
  }

  const cleaned = pending
    .map((message) => ({
      content: createUserContent(message.content, hasStoredPrompt).trim(),
      receivedAt: message.receivedAt,
    }))
    .filter((message) => message.content.length > 0);

  if (!cleaned.length) {
    sessionSteeringMessages.delete(sessionId);
    return 0;
  }

  const steeringContent = formatSteeringContent(cleaned);
  const lastMessage = session.history.at(-1);
  let poppedLastMessage: typeof lastMessage | undefined;
  try {
    if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string') {
      poppedLastMessage = session.history.pop();
      pushToSessionHistory(log, session, {
        ...lastMessage,
        content: [lastMessage.content.trimEnd(), steeringContent].join('\n\n'),
      });
    } else {
      pushToSessionHistory(log, session, {
        role: 'user',
        content: steeringContent,
      });
    }
  } catch (err) {
    if (poppedLastMessage) session.history[session.history.length] = poppedLastMessage;
    sessionSteeringMessages.set(sessionId, pending);
    throw err;
  }

  sessionSteeringMessages.delete(sessionId);
  session.lastModelPromptTokens = undefined;

  log.info('Applied steering messages to active agent turn', {
    sessionId,
    steeringMessageCount: cleaned.length,
  });

  return cleaned.length;
}

export function getPendingSteeringMessageCount(sessionId: string): number {
  const pending = sessionSteeringMessages.get(sessionId) ?? [];
  const fresh = pending.filter((message) => isFreshSteeringMessage(message));
  if (fresh.length !== pending.length) {
    if (fresh.length > 0) {
      sessionSteeringMessages.set(sessionId, fresh);
    } else {
      sessionSteeringMessages.delete(sessionId);
    }
  }
  return fresh.length;
}

export function takePendingSteeringMessages(
  sessionId: string,
  log: Logger,
): PendingSteeringMessage[] {
  const pending = freshPendingSteeringMessages(sessionId, log);
  sessionSteeringMessages.delete(sessionId);
  return pending;
}

export function clearSteeringMessages(sessionId: string): number {
  const count = sessionSteeringMessages.get(sessionId)?.length ?? 0;
  sessionSteeringMessages.delete(sessionId);
  return count;
}

export function sendSteeringAppliedNotice(
  send: AgentSendFn,
  sessionId: string,
  steeringMessageCount: number,
): void {
  send({
    session_id: sessionId,
    sender: 'agent',
    content: `Applied ${steeringMessageCount} steering update${
      steeringMessageCount === 1 ? '' : 's'
    } to the current task.`,
    is_terminal_output: false,
    is_error: false,
    is_steering: true,
  });
}
