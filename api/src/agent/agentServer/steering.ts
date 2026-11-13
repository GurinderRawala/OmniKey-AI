import type { AIMessage, AITool } from '../../ai-client';
import type { SkillSnapshot } from '../../skills/contracts';
import { SkillError } from '../../skills/contracts';
import type { Logger } from 'winston';
import { isInjectedUserPrompt } from '../injectedUserPrompts';
import { pushToSessionHistory, createUserContent } from '../utils';
import type { AgentMessage, AgentSendFn, SessionState } from '../types';
import type { PendingSteeringMessage } from './serverTypes';
import { sessionSteeringIds, sessionSteeringMessages } from './runtimeState';
import { addDiffRecoverySteering } from '../gitDiff/recovery';
import {
  assertSkillRequestFits,
  SkillContextBudgetError,
  commitSteeringSkills,
  hasUnpreparedSteering,
  prepareSteeringSkills,
} from '../skillContext';

export const MAX_STEERING_RESTARTS = 8;
export const MAX_STEERING_ID_LENGTH = 128;
export const MAX_RETAINED_STEERING_IDS = 256;
export const MAX_PENDING_STEERING_MESSAGES = 8;
export const MAX_PENDING_STEERING_CONTENT_CHARS = 16_000;
export const STEERING_MESSAGE_TTL_MS = 30 * 60 * 1000;
export const STEERING_RESTART_LIMIT_MESSAGE =
  'The agent received too many steering updates before it could make progress. The work so far has been saved; please send one consolidated follow-up.';

export interface EnqueueSteeringResult {
  accepted: boolean;
  pendingCount: number;
  rejectionReason?: string;
  // The steering_id was already seen (pending/applied/rejected) in this run.
  duplicate?: boolean;
}

export interface SteeringRestartBudget {
  used: number;
  max: number;
}

function steeringId(message: AgentMessage): string {
  return (
    message.steering_id?.trim() || `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
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

function freshPendingSteeringMessages(sessionId: string, log: Logger): PendingSteeringMessage[] {
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

export function enqueueSteeringMessage(
  sessionId: string,
  message: AgentMessage,
  log: Logger,
  replyTo?: AgentSendFn,
): EnqueueSteeringResult {
  // Per-run, synchronous ID dedup: a retried steering_id is never enqueued,
  // applied or acknowledged twice. Legacy messages without an ID cannot be
  // correlated and are not deduplicated.
  const rawId = message.steering_id;
  if (rawId !== undefined && (typeof rawId !== 'string' || rawId.length > MAX_STEERING_ID_LENGTH)) {
    return {
      accepted: false,
      pendingCount: sessionSteeringMessages.get(sessionId)?.length ?? 0,
      rejectionReason: 'Steering identifier is invalid or too long.',
    };
  }
  const clientSteeringId = rawId?.trim() ?? '';
  const seenIds = sessionSteeringIds.get(sessionId);
  if (clientSteeringId && seenIds?.has(clientSteeringId)) {
    return {
      accepted: false,
      duplicate: true,
      pendingCount: sessionSteeringMessages.get(sessionId)?.length ?? 0,
    };
  }
  if (seenIds && seenIds.size >= MAX_RETAINED_STEERING_IDS) {
    return {
      accepted: false,
      pendingCount: sessionSteeringMessages.get(sessionId)?.length ?? 0,
      rejectionReason:
        'This task has received too many steering identifiers. Send a new task instead.',
    };
  }
  if (clientSteeringId && seenIds) seenIds.add(clientSteeringId);

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
    steeringId: steeringId(message),
    content,
    platform: message.platform,
    groupName: message.group_name,
    receivedAt: new Date().toISOString(),
    replyTo,
    supportsSkillStatus: message.supports_skill_status === true,
    skillsEligible: message.sender === 'client',
  });
  sessionSteeringMessages.set(sessionId, pending);

  log.info('Queued steering message for active agent turn', {
    sessionId,
    pendingSteeringMessages: pending.length,
    contentLength: content.length,
  });

  return { accepted: true, pendingCount: pending.length };
}

/** Use identical append semantics for a scratch preflight and the real commit. */
function historyWithSteering(
  session: SessionState,
  pending: readonly PendingSteeringMessage[],
  hasStoredPrompt: boolean,
  log: Logger,
  commit = false,
): AIMessage[] {
  const cleaned = pending
    .map((message) => ({
      content: createUserContent(message.content, hasStoredPrompt).trim(),
      receivedAt: message.receivedAt,
    }))
    .filter((message) => message.content.length > 0);
  if (!cleaned.length) return session.history.slice();
  const scratch = commit ? session : { ...session, history: session.history.slice() };
  // Index instead of Array#at: the runtime package still supports Node 14.
  const last = scratch.history[scratch.history.length - 1];
  const content = formatSteeringContent(cleaned);
  let popped: AIMessage | undefined;
  try {
    if (
      last?.role === 'user' &&
      typeof last.content === 'string' &&
      !isInjectedUserPrompt(last.content)
    ) {
      popped = scratch.history.pop();
      pushToSessionHistory(log, scratch, {
        ...last,
        content: [last.content.trimEnd(), content].join('\n\n'),
      });
    } else pushToSessionHistory(log, scratch, { role: 'user', content });
  } catch (err) {
    if (popped) scratch.history[scratch.history.length] = popped;
    throw err;
  }
  return scratch.history;
}

export function drainSteeringMessagesIntoHistory(
  sessionId: string,
  session: SessionState,
  hasStoredPrompt: boolean,
  log: Logger,
): PendingSteeringMessage[] {
  const existingPendingCount = sessionSteeringMessages.get(sessionId)?.length ?? 0;
  const pending = freshPendingSteeringMessages(sessionId, log);
  if (!pending?.length) {
    if (existingPendingCount > 0) sessionSteeringMessages.delete(sessionId);
    return [];
  }

  const cleaned = pending
    .map((message) => ({
      steeringId: message.steeringId,
      content: createUserContent(message.content, hasStoredPrompt).trim(),
      receivedAt: message.receivedAt,
    }))
    .filter((message) => message.content.length > 0);

  if (!cleaned.length) {
    sessionSteeringMessages.delete(sessionId);
    return [];
  }

  const previousHistory = session.history;
  try {
    session.history = historyWithSteering(session, pending, hasStoredPrompt, log, true);
  } catch (err) {
    session.history = previousHistory;
    sessionSteeringMessages.set(sessionId, pending);
    throw err;
  }

  sessionSteeringMessages.delete(sessionId);
  session.lastModelPromptTokens = undefined;

  log.info('Applied steering messages to active agent turn', {
    sessionId,
    steeringMessageCount: cleaned.length,
  });

  const appliedIDs = new Set(cleaned.map((message) => message.steeringId));
  return pending.filter((message) => appliedIDs.has(message.steeringId));
}

/**
 * Drain point used by every active-run path. For runs with Skills state, each
 * pending steering input is first resolved FIFO (failures rejected alone);
 * the synchronous check below guarantees nothing unresolved is drained. The
 * resolved skills are committed only for steering actually applied.
 */
export async function drainSteeringMessagesForRun(
  sessionId: string,
  session: SessionState,
  hasStoredPrompt: boolean,
  log: Logger,
  tools: readonly AITool[],
): Promise<PendingSteeringMessage[]> {
  // TTL-expired steering is dropped before and during preparation (seen IDs
  // are kept), exactly as the synchronous drain below would drop it.
  const discardExpired = () => {
    const pending = sessionSteeringMessages.get(sessionId);
    if (!pending?.length) return;
    const fresh = freshPendingSteeringMessages(sessionId, log);
    if (fresh.length === pending.length) return;
    if (fresh.length > 0) sessionSteeringMessages.set(sessionId, fresh);
    else sessionSteeringMessages.delete(sessionId);
  };
  while (hasUnpreparedSteering(sessionId, session)) {
    await prepareSteeringSkills(
      sessionId,
      session,
      log,
      discardExpired,
      (snapshots: readonly SkillSnapshot[], pending: readonly PendingSteeringMessage[]) => {
        const run = session.skillRun;
        if (!run || !snapshots.length) return;
        const history = historyWithSteering(session, pending, hasStoredPrompt, log);
        const candidate = {
          ...session,
          history,
          skillRun: {
            ...run,
            active: [...snapshots],
            activeIds: new Set(snapshots.map((s) => s.id)),
            anchorContent: history[history.length - 1]?.content,
          },
        };
        try {
          assertSkillRequestFits(candidate, session.activeModel ?? '', sessionId, tools);
        } catch (error) {
          if (!(error instanceof SkillContextBudgetError)) throw error;
          throw new SkillError(
            413,
            'CONTEXT_LIMIT_EXCEEDED',
            'Matched skill instructions exceed the context budget. Shorten or disable skills.',
          );
        }
      },
    );
  }
  const applied = drainSteeringMessagesIntoHistory(sessionId, session, hasStoredPrompt, log);
  commitSteeringSkills(session, applied);
  // Only steering applied to this run's history informs diff recovery.
  if (applied.length)
    addDiffRecoverySteering(
      session.gitRun,
      applied.map((m) => m.content),
    );
  return applied;
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
  steeringMessages: PendingSteeringMessage[],
): void {
  // The acknowledgement goes to the connection that sent the steering (its
  // received/rejected acks use the same channel); Skills status notices stay
  // on the documented turn-owner channel.
  for (const message of steeringMessages) {
    (message.replyTo ?? send)({
      session_id: sessionId,
      sender: 'agent',
      content: 'Applied steering update to the current task.',
      is_terminal_output: false,
      is_error: false,
      is_steering: true,
      steering_id: message.steeringId,
      steering_status: 'applied',
    });
  }
}
