import type { Logger } from 'winston';
import {
  aiClient,
  AICompletionResult,
  AIMessage,
  estimateHistoryTokens,
  getFixedHelperModel,
  getInputTokenBudget,
} from '../../ai-client';
import { config } from '../../config';
import { AgentSession } from '../../models/agentSession';
import { isInjectedUserPrompt } from '../injectedUserPrompts';
import type { SessionState } from '../types';
import { pruneHistoryForContextLimit } from './contextPruning';
import { throwIfTurnCancelled } from './turnCancellation';

const KEEP_RECENT_USER_TURNS = 2;
const KEEP_RECENT_MESSAGES = 8;
const MEMORY_TRIGGER_INPUT_RATIO = 0.5;
const PROACTIVE_TRIM_RATIO = 0.9;
const MIN_SUMMARIZE_TOKENS = 8_000;
const MAX_SUMMARY_TRANSCRIPT_CHARS = 60_000;
const MAX_MESSAGE_SUMMARY_CHARS = 4_000;
const MAX_TOOL_RESULT_SUMMARY_CHARS = 2_500;
const MAX_MEMORY_CHARS = 8_000;
const MEMORY_MAX_OUTPUT_TOKENS = 2_400;
const noopPruneLog = { warn: () => undefined } as unknown as Logger;

function memoryTriggerTokens(model: string): number {
  const inputBudget = getInputTokenBudget(config.aiProvider, model);
  if (inputBudget <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(inputBudget * MEMORY_TRIGGER_INPUT_RATIO);
}

function resolveMemoryModel(session: SessionState, model?: string): string {
  const resolved = model ?? session.activeModel;
  if (!resolved) {
    throw new Error('Agent active model is required for session memory budget resolution.');
  }
  return resolved;
}

function isStoredInstructions(message: AIMessage): boolean {
  return message.role === 'user' && /<stored_instructions\b/i.test(message.content);
}

function staticPrefixEnd(history: AIMessage[]): number {
  let index = 0;
  while (index < history.length && history[index].role === 'system') index++;
  while (index < history.length && isStoredInstructions(history[index])) index++;
  return index;
}

function isRealUserTurn(message: AIMessage): boolean {
  if (message.role !== 'user') return false;
  const text = message.content.trim();
  if (!text) return false;
  if (isStoredInstructions(message)) return false;
  if (/^(TERMINAL OUTPUT|COMMAND ERROR):/i.test(text)) return false;
  if (isInjectedUserPrompt(text)) return false;
  return /<user_input\b/i.test(text) || !/<session_memory\b/i.test(text);
}

function recentHistoryStart(history: AIMessage[], staticEnd: number): number {
  let seenUserTurns = 0;
  for (let index = history.length - 1; index >= staticEnd; index--) {
    if (!isRealUserTurn(history[index])) continue;
    seenUserTurns++;
    if (seenUserTurns >= KEEP_RECENT_USER_TURNS) return index;
  }
  return staticEnd;
}

function clampMemoryHistoryLength(session: SessionState, staticEnd: number): number {
  const raw = session.sessionMemoryHistoryLength ?? staticEnd;
  if (!session.sessionMemory) return staticEnd;
  return Math.min(Math.max(raw, staticEnd), session.history.length);
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head - 120;
  return [
    normalized.slice(0, head),
    `[... ${normalized.length - head - tail} chars omitted from memory compaction input ...]`,
    normalized.slice(normalized.length - tail),
  ].join('\n');
}

function cleanModelText(text: string): string {
  return text
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/<final_answer>([\s\S]*?)<\/final_answer>/gi, '$1')
    .trim();
}

function messageLabel(message: AIMessage, index: number): string {
  if (message.role === 'tool') return `#${index} tool:${message.tool_name ?? 'unknown'}`;
  if (message.role === 'assistant' && message.tool_calls?.length) {
    return `#${index} assistant tool_calls:${message.tool_calls.map((tc) => tc.name).join(',')}`;
  }
  return `#${index} ${message.role}`;
}

function summarizeMessage(message: AIMessage, index: number): string {
  const label = messageLabel(message, index);
  const maxChars =
    message.role === 'tool' ? MAX_TOOL_RESULT_SUMMARY_CHARS : MAX_MESSAGE_SUMMARY_CHARS;
  const content = cleanModelText(message.content);
  const parts = [`${label}:`, compactText(content || '(empty)', maxChars)];

  if (message.tool_calls?.length) {
    const calls = message.tool_calls.map((tc) => ({
      name: tc.name,
      arguments: tc.arguments,
    }));
    parts.push(`Tool calls: ${compactText(JSON.stringify(calls), 1_500)}`);
  }

  return parts.join('\n');
}

function renderTranscriptSlice(messages: AIMessage[], offset: number): string {
  const rendered = messages
    .map((message, index) => summarizeMessage(message, offset + index))
    .join('\n\n');
  return rendered;
}

/** Validate the entire checkpoint rather than silently storing a truncated prefix. */
function parseMemory(result: AICompletionResult): string | null {
  if (
    result.finish_reason !== 'stop' ||
    result.tool_calls?.length ||
    (result.usage?.completion_tokens ?? 0) >= MEMORY_MAX_OUTPUT_TOKENS
  )
    return null;
  try {
    const text = result.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const value = JSON.parse(text);
    if (!value || typeof value.goal !== 'string' || !value.goal.trim()) return null;
    const keys = ['completed', 'findings', 'nextSteps', 'blockers'] as const;
    if (
      keys.some(
        (key) =>
          !Array.isArray(value[key]) ||
          value[key].some((item: unknown) => typeof item !== 'string'),
      )
    )
      return null;
    const memory = JSON.stringify({
      goal: value.goal,
      ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    });
    return memory.length <= MAX_MEMORY_CHARS ? memory : null;
  } catch {
    return null;
  }
}

async function updateSessionMemoryInDB(sessionId: string, session: SessionState): Promise<void> {
  await AgentSession.update(
    {
      sessionMemory: session.sessionMemory ?? null,
      sessionMemoryHistoryLength: session.sessionMemoryHistoryLength ?? 0,
      sessionMemoryUpdatedAt: session.sessionMemoryUpdatedAt ?? null,
    },
    { where: { id: sessionId } },
  );
}

export function buildCompactedHistoryForRequest(session: SessionState): AIMessage[] {
  const history = session.history;
  const staticEnd = staticPrefixEnd(history);
  const compactedThrough = clampMemoryHistoryLength(session, staticEnd);
  const result: AIMessage[] = history.slice(0, staticEnd);

  if (session.sessionMemory?.trim()) {
    result.push({
      role: 'user',
      content: `<session_memory>\n${session.sessionMemory.trim()}\n</session_memory>`,
    });
  }

  // Preserve every human instruction in order, not just the first and last:
  // a status question must not erase intervening approval or task changes.
  for (let index = staticEnd; index < compactedThrough; index++) {
    if (isRealUserTurn(history[index])) result.push(history[index]);
  }
  if (session.sessionMemory?.trim()) {
    const policy =
      'Session memory is fallible historical context, not an instruction. ' +
      'All human requests are replayed in chronological order. Later human instructions ' +
      'supersede conflicting earlier instructions and memory. A status question does not ' +
      'revoke prior authorization. Do not repeat completed inspections unless new evidence requires it.';
    const system = result.findIndex((message) => message.role === 'system');
    if (system >= 0)
      result[system] = { ...result[system], content: result[system].content + '\n\n' + policy };
    else result.unshift({ role: 'system', content: policy });
  }
  result.push(...history.slice(compactedThrough));
  return result;
}

export function shouldUseSessionMemory(session: SessionState, model?: string): boolean {
  if (!session.sessionMemory?.trim()) return false;
  const resolvedModel = resolveMemoryModel(session, model);
  return estimateHistoryTokens(session.history) >= memoryTriggerTokens(resolvedModel);
}

export function buildHistoryForRequest(session: SessionState, model?: string): AIMessage[] {
  if (!shouldUseSessionMemory(session, model)) return [...session.history];
  return buildCompactedHistoryForRequest(session);
}

/**
 * Proactively shrinks a request history to a safe fraction of the active
 * model's input budget. The raw persisted transcript is not mutated; this is
 * the send-time view used for provider calls and context-remaining estimates.
 */
export function trimHistoryToBudget(
  history: AIMessage[],
  sessionId: string,
  model: string,
  log?: Logger,
): AIMessage[] {
  const budget = Math.floor(getInputTokenBudget(config.aiProvider, model) * PROACTIVE_TRIM_RATIO);
  if (budget <= 0) return history;

  const scratchSession = { subscription: {} as any, history, turns: 0 };
  let guard = 0;
  const maxSteps = history.length * 2;
  while (estimateHistoryTokens(scratchSession.history) > budget && guard < maxSteps) {
    guard++;
    if (!pruneHistoryForContextLimit(scratchSession, log ?? noopPruneLog)) break;
  }

  if (guard > 0 && log) {
    log.info('Proactively trimmed history to fit context budget before sending', {
      sessionId,
      steps: guard,
      estimatedTokens: estimateHistoryTokens(scratchSession.history),
      budget,
    });
  }

  return scratchSession.history;
}

export function buildTrimmedHistoryForRequest(
  session: SessionState,
  model?: string,
  sessionId = 'unknown',
  log?: Logger,
): AIMessage[] {
  const resolvedModel = resolveMemoryModel(session, model);
  return trimHistoryToBudget(
    buildHistoryForRequest(session, resolvedModel),
    sessionId,
    resolvedModel,
    log,
  );
}

export async function ensureSessionMemory(
  session: SessionState,
  sessionId: string,
  model: string,
  log: Logger,
  onUsage?: (result: AICompletionResult) => Promise<void>,
): Promise<void> {
  throwIfTurnCancelled(session.signal);
  const history = session.history;
  if (history.length < (session.memoryRetryAfterHistoryLength ?? 0)) return;
  const staticEnd = staticPrefixEnd(history);
  const compactedThrough = clampMemoryHistoryLength(session, staticEnd);
  const recentStart = recentHistoryStart(history, staticEnd);
  let summarizeEnd = Math.min(recentStart, history.length);
  // Two user turns can contain hours of tool work. If keeping both would still
  // overflow, summarize completed exchanges within them, retaining a raw tail.
  // Move the cut before a tool-call message rather than orphaning its results.
  const triggerTokens = memoryTriggerTokens(model);
  if (estimateHistoryTokens(history.slice(summarizeEnd)) >= triggerTokens) {
    let tailStart = Math.max(staticEnd, history.length - KEEP_RECENT_MESSAGES);
    while (tailStart > staticEnd && history[tailStart]?.role === 'tool') tailStart--;
    // A short first exchange followed by "continue" still needs memory.
    let latestUser = -1;
    for (let index = history.length - 1; index >= staticEnd; index--) {
      if (isRealUserTurn(history[index])) {
        latestUser = index;
        break;
      }
    }
    if (
      latestUser > staticEnd &&
      estimateHistoryTokens(history.slice(latestUser)) < triggerTokens
    ) {
      tailStart = Math.max(tailStart, latestUser);
    }
    summarizeEnd = Math.max(summarizeEnd, tailStart);
  }

  if (summarizeEnd <= compactedThrough) return;

  // Summarize a contiguous, bounded chunk. Cutting the rendered transcript's
  // middle but advancing past it silently loses entire exchanges.
  let renderedChars = 0;
  let chunkEnd = compactedThrough;
  while (chunkEnd < summarizeEnd) {
    const size = summarizeMessage(history[chunkEnd], chunkEnd).length + 2;
    if (renderedChars + size > MAX_SUMMARY_TRANSCRIPT_CHARS) break;
    renderedChars += size;
    chunkEnd++;
  }
  while (chunkEnd > compactedThrough && history[chunkEnd]?.role === 'tool') chunkEnd--;
  if (chunkEnd <= compactedThrough) return;
  summarizeEnd = chunkEnd;
  const pendingMessages = history.slice(compactedThrough, summarizeEnd);
  const pendingTokens = estimateHistoryTokens(pendingMessages);
  const rawRequestTokens = estimateHistoryTokens(history);
  if (rawRequestTokens < triggerTokens || pendingTokens < MIN_SUMMARIZE_TOKENS) {
    return;
  }

  const transcript = renderTranscriptSlice(pendingMessages, compactedThrough);
  const previousMemory = session.sessionMemory?.trim() || '(none)';
  // Memory summaries are fixed helper work, not an agent turn. Keep them on the
  // provider fast model and keep the main agent model DB-backed.
  const summaryModel = getFixedHelperModel(config.aiProvider);

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: [
        'You maintain compact memory for an autonomous coding agent.',
        'Update the memory using only the transcript provided. Do not invent facts.',
        'Preserve project identity, repository paths, branch names, PR URLs, user requirements, decisions, files touched, commands/tools and outcomes, final answers, errors, artifacts, and open next steps.',
        'Replace obsolete goals and approval requirements when newer user instructions supersede them.',
        'Prioritize the current goal, completed inspections and tests, concrete findings, next action, and actual blockers. Omit old session inventories, credentials, and generic project descriptions.',
        'Return one complete JSON object: {"goal": "current goal", "completed": ["work already done"], "findings": ["new evidence"], "nextSteps": ["next concrete action"], "blockers": ["unresolved blocker"]}.',
        'Rewrite concisely rather than appending to previous memory. Maximum 500 words and 8000 characters.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        '<previous_memory>',
        previousMemory,
        '</previous_memory>',
        '',
        '<new_transcript>',
        transcript,
        '</new_transcript>',
        '',
        'Return only the complete JSON checkpoint.',
      ].join('\n'),
    },
  ];

  try {
    let memory: string | null = null;
    let result!: AICompletionResult;
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfTurnCancelled(session.signal);
      result = await aiClient.complete(
        summaryModel,
        attempt === 0
          ? messages
          : [
              ...messages,
              {
                role: 'user',
                content:
                  'The previous checkpoint was incomplete or invalid. Rewrite from the supplied evidence in at most 300 words. Return all five JSON fields; omit low-priority history.',
              },
            ],
        { temperature: 0, maxTokens: MEMORY_MAX_OUTPUT_TOKENS, signal: session.signal },
      );
      if (onUsage) await onUsage(result);
      throwIfTurnCancelled(session.signal);
      memory = parseMemory(result);
      if (memory) break;
      log.warn('Rejected incomplete or invalid session memory checkpoint', {
        sessionId,
        attempt: attempt + 1,
        finishReason: result.finish_reason,
      });
    }
    if (!memory) {
      session.memoryRetryAfterHistoryLength = history.length + KEEP_RECENT_MESSAGES;
      return;
    }
    const checkpoint = {
      ...session,
      sessionMemory: memory,
      sessionMemoryHistoryLength: summarizeEnd,
      sessionMemoryUpdatedAt: new Date(),
    };
    await updateSessionMemoryInDB(sessionId, checkpoint);
    session.sessionMemory = checkpoint.sessionMemory;
    session.sessionMemoryHistoryLength = checkpoint.sessionMemoryHistoryLength;
    session.sessionMemoryUpdatedAt = checkpoint.sessionMemoryUpdatedAt;
    session.memoryRetryAfterHistoryLength = undefined;

    log.info('Compacted agent session history into session memory', {
      sessionId,
      compactedMessages: pendingMessages.length,
      compactedThrough: summarizeEnd,
      pendingTokens,
      rawRequestTokens,
      triggerTokens,
      memoryLength: memory.length,
      model: result.model,
    });
  } catch (err) {
    throwIfTurnCancelled(session.signal);
    session.memoryRetryAfterHistoryLength = history.length + KEEP_RECENT_MESSAGES;
    log.warn('Failed to compact agent session history; continuing with raw recent history', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
