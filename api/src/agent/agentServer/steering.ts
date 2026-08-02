import type { Logger } from 'winston';
import { pushToSessionHistory, createUserContent } from '../utils';
import type { AgentMessage, AgentSendFn, SessionState } from '../types';
import { sessionSteeringMessages } from './runtimeState';

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
): number {
  const content = normalizeSteeringContent(message.content ?? '');
  if (!content) return sessionSteeringMessages.get(sessionId)?.length ?? 0;

  const pending = sessionSteeringMessages.get(sessionId) ?? [];
  pending.push({
    content,
    platform: message.platform,
    receivedAt: new Date().toISOString(),
  });
  sessionSteeringMessages.set(sessionId, pending);

  log.info('Queued steering message for active agent turn', {
    sessionId,
    pendingSteeringMessages: pending.length,
    contentLength: content.length,
  });

  return pending.length;
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

  pushToSessionHistory(log, session, {
    role: 'user',
    content: formatSteeringContent(cleaned),
  });
  session.lastModelPromptTokens = undefined;

  log.info('Applied steering messages to active agent turn', {
    sessionId,
    steeringMessageCount: cleaned.length,
  });

  return cleaned.length;
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
