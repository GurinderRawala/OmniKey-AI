import type { Logger } from 'winston';
import { pushToSessionHistory, createUserContent } from '../utils';
import type { AgentMessage, AgentSendFn, SessionState } from '../types';
import { sessionSteeringMessages } from './runtimeState';

export interface EnqueueSteeringResult {
  accepted: boolean;
  pendingCount: number;
}

function normalizeSteeringContent(content: string): string {
  return content.trim();
}

function formatSteeringContent(messages: Array<{ content: string; receivedAt: string }>): string {
  const body =
    messages.length === 1
      ? messages[0].content
      : messages
          .map((message, index) =>
            [`Update ${index + 1} (${message.receivedAt}):`, message.content].join('\n'),
          )
          .join('\n\n');

  return [
    '<user_steering priority="current_turn" semantics="newer_user_guidance">',
    body,
    '</user_steering>',
  ].join('\n');
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

  const pending = sessionSteeringMessages.get(sessionId) ?? [];
  pending.push({
    content,
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
  const pending = sessionSteeringMessages.get(sessionId);
  if (!pending?.length) return 0;

  sessionSteeringMessages.delete(sessionId);
  const cleaned = pending
    .map((message) => ({
      content: createUserContent(message.content, hasStoredPrompt).trim(),
      receivedAt: message.receivedAt,
    }))
    .filter((message) => message.content.length > 0);

  if (!cleaned.length) return 0;

  const steeringContent = formatSteeringContent(cleaned);
  const lastMessage = session.history.at(-1);
  if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string') {
    lastMessage.content = [lastMessage.content.trimEnd(), steeringContent].join('\n\n');
  } else {
    pushToSessionHistory(log, session, {
      role: 'user',
      content: steeringContent,
    });
  }
  session.lastModelPromptTokens = undefined;

  log.info('Applied steering messages to active agent turn', {
    sessionId,
    steeringMessageCount: cleaned.length,
  });

  return cleaned.length;
}

export function getPendingSteeringMessageCount(sessionId: string): number {
  return sessionSteeringMessages.get(sessionId)?.length ?? 0;
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
