import type { Logger } from 'winston';
import {
  aiClient,
  AICompletionResult,
  AIMessage,
  estimateHistoryTokens,
  getDefaultModel,
} from '../../ai-client';
import { config } from '../../config';
import { AgentSession } from '../../models/agentSession';
import { isInjectedUserPrompt } from '../injectedUserPrompts';
import type { SessionState } from '../types';

const KEEP_RECENT_USER_TURNS = 2;
const MEMORY_TRIGGER_TOKENS = 12_000;
const MIN_SUMMARIZE_TOKENS = 3_000;
const MAX_SUMMARY_TRANSCRIPT_CHARS = 60_000;
const MAX_MESSAGE_SUMMARY_CHARS = 4_000;
const MAX_TOOL_RESULT_SUMMARY_CHARS = 2_500;
const MAX_MEMORY_CHARS = 8_000;
const MEMORY_MAX_OUTPUT_TOKENS = 1_400;

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
    .replace(/<project_context[^>]*>[\s\S]*?<\/project_context>/gi, '')
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
  return compactText(rendered, MAX_SUMMARY_TRANSCRIPT_CHARS);
}

function stripSummaryResponse(content: string): string {
  return content
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/<\/?session_memory>/gi, '')
    .trim()
    .slice(0, MAX_MEMORY_CHARS);
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

  result.push(...history.slice(compactedThrough));
  return result;
}

export async function ensureSessionMemory(
  session: SessionState,
  sessionId: string,
  log: Logger,
  onUsage?: (result: AICompletionResult) => Promise<void>,
): Promise<void> {
  const history = session.history;
  const staticEnd = staticPrefixEnd(history);
  const compactedThrough = clampMemoryHistoryLength(session, staticEnd);
  const recentStart = recentHistoryStart(history, staticEnd);
  const summarizeEnd = Math.min(recentStart, history.length);

  if (summarizeEnd <= compactedThrough) return;

  const pendingMessages = history.slice(compactedThrough, summarizeEnd);
  const pendingTokens = estimateHistoryTokens(pendingMessages);
  const currentRequestTokens = estimateHistoryTokens(buildCompactedHistoryForRequest(session));

  if (currentRequestTokens < MEMORY_TRIGGER_TOKENS && pendingTokens < MIN_SUMMARIZE_TOKENS) {
    return;
  }

  const transcript = renderTranscriptSlice(pendingMessages, compactedThrough);
  const previousMemory = session.sessionMemory?.trim() || '(none)';
  const summaryModel = getDefaultModel(config.aiProvider, 'fast');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: [
        'You maintain compact memory for an autonomous coding agent.',
        'Update the memory using only the transcript provided. Do not invent facts.',
        'Preserve user requirements, decisions, files touched, commands/tools and outcomes, final answers, errors, artifacts, and open next steps.',
        'Write concise Markdown bullets under stable headings. Keep enough detail for the main agent to resume without replaying old raw transcript.',
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
        'Return only the updated compact memory. Maximum 900 words.',
      ].join('\n'),
    },
  ];

  try {
    const result = await aiClient.complete(summaryModel, messages, {
      temperature: 0,
      maxTokens: MEMORY_MAX_OUTPUT_TOKENS,
    });
    if (onUsage) await onUsage(result);

    const memory = stripSummaryResponse(result.content);
    if (!memory) return;

    session.sessionMemory = memory;
    session.sessionMemoryHistoryLength = summarizeEnd;
    session.sessionMemoryUpdatedAt = new Date();
    await updateSessionMemoryInDB(sessionId, session);

    log.info('Compacted agent session history into session memory', {
      sessionId,
      compactedMessages: pendingMessages.length,
      compactedThrough: summarizeEnd,
      pendingTokens,
      memoryLength: memory.length,
      model: result.model,
    });
  } catch (err) {
    log.warn('Failed to compact agent session history; continuing with raw recent history', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
