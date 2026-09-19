import { createHash } from 'crypto';
import { MCP_TOOL_PREFIX } from '../mcpRuntime';
import { isInjectedUserPrompt } from '../injectedUserPrompts';
import type { SessionState } from '../types';
import { extractProgressSummary } from './progressSummary';

export type HistoryBlockKind =
  | 'agentReasoning'
  | 'shellCommand'
  | 'terminalOutput'
  | 'webCall'
  | 'mcpCall'
  | 'imageRendering'
  | 'finalAnswer';

export type RawHistoryMessage = {
  role: string;
  content: unknown;
  tool_name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type TranscriptBlock = {
  id: string;
  kind: HistoryBlockKind;
  text: string;
  activityId?: string;
  activityPhase?: 'pending' | 'started' | 'completed' | 'failed' | 'cancelled';
  contentLength?: number;
  isContentTruncated?: boolean;
  contentId?: string;
};

export type TranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  blocks?: TranscriptBlock[];
};

export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 24;
export const MAX_TRANSCRIPT_PAGE_SIZE = 50;

type TranscriptCursorPayload = {
  version: 2;
  sessionId: string;
  beforeId: string;
  prefixRevision: string;
};

export class InvalidTranscriptCursorError extends Error {
  constructor() {
    super('Invalid transcript cursor');
    this.name = 'InvalidTranscriptCursorError';
  }
}

function transcriptPrefixRevision(messages: TranscriptMessage[], before: number): string {
  const hash = createHash('sha256');
  for (const message of messages.slice(0, before)) {
    hash.update(message.id);
    hash.update('\0');
    hash.update(message.role);
    hash.update('\0');
    hash.update(message.text);
    for (const block of message.blocks ?? []) {
      hash.update('\0');
      hash.update(block.id);
      hash.update('\0');
      hash.update(block.text);
    }
  }
  return hash.digest('base64url').slice(0, 22);
}

function encodeTranscriptCursor(
  messages: TranscriptMessage[],
  sessionId: string,
  before: number,
): string {
  const payload: TranscriptCursorPayload = {
    version: 2,
    sessionId,
    beforeId: before < messages.length ? messages[before].id : '__end__',
    prefixRevision: transcriptPrefixRevision(messages, before),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeTranscriptCursor(
  cursor: string,
  sessionId: string,
  messages: TranscriptMessage[],
): number {
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<TranscriptCursorPayload>;
    if (
      payload.version !== 2 ||
      payload.sessionId !== sessionId ||
      typeof payload.beforeId !== 'string' ||
      typeof payload.prefixRevision !== 'string'
    ) {
      throw new InvalidTranscriptCursorError();
    }
    const before =
      payload.beforeId === '__end__'
        ? messages.length
        : messages.findIndex((message) => message.id === payload.beforeId);
    if (before < 0 || transcriptPrefixRevision(messages, before) !== payload.prefixRevision) {
      throw new InvalidTranscriptCursorError();
    }
    return before;
  } catch (error) {
    if (error instanceof InvalidTranscriptCursorError) throw error;
    throw new InvalidTranscriptCursorError();
  }
}

export function transcriptPageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_TRANSCRIPT_PAGE_SIZE;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidTranscriptCursorError();
  return Math.min(parsed, MAX_TRANSCRIPT_PAGE_SIZE);
}

/**
 * Slices only after the provider history has been converted into complete UI
 * messages. This guarantees an assistant timeline and all of its tool blocks
 * remain together on one page. The absolute boundary remains stable when new
 * messages are appended to the transcript.
 */
export function paginateTranscript(
  messages: TranscriptMessage[],
  sessionId: string,
  limit: number,
  before?: string,
): {
  messages: TranscriptMessage[];
  pageInfo: { hasMoreBefore: boolean; startCursor: string; endCursor: string };
} {
  const end = before ? decodeTranscriptCursor(before, sessionId, messages) : messages.length;
  const start = Math.max(0, end - Math.min(limit, MAX_TRANSCRIPT_PAGE_SIZE));
  return {
    messages: messages.slice(start, end),
    pageInfo: {
      hasMoreBefore: start > 0,
      startCursor: encodeTranscriptCursor(messages, sessionId, start),
      endCursor: encodeTranscriptCursor(messages, sessionId, end),
    },
  };
}

export function paginateTranscriptTurns(
  messages: TranscriptMessage[],
  sessionId: string,
  turns: number,
  before: string,
): ReturnType<typeof paginateTranscript> {
  const end = decodeTranscriptCursor(before, sessionId, messages);
  let start = end;
  let assistantTurns = 0;
  while (start > 0) {
    start -= 1;
    if (messages[start].role === 'assistant') assistantTurns += 1;
    if (assistantTurns >= turns) {
      while (start > 0 && messages[start - 1].role === 'user') start -= 1;
      break;
    }
  }
  return {
    messages: messages.slice(start, end),
    pageInfo: {
      hasMoreBefore: start > 0,
      startCursor: encodeTranscriptCursor(messages, sessionId, start),
      endCursor: encodeTranscriptCursor(messages, sessionId, end),
    },
  };
}

export function latestTranscriptTurn(
  messages: TranscriptMessage[],
  sessionId: string,
): ReturnType<typeof paginateTranscript> {
  if (!messages.length) {
    return {
      messages: [],
      pageInfo: {
        hasMoreBefore: false,
        startCursor: encodeTranscriptCursor(messages, sessionId, 0),
        endCursor: encodeTranscriptCursor(messages, sessionId, 0),
      },
    };
  }
  let lastAssistant = -1;
  let lastCompletedAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      if (lastAssistant < 0) lastAssistant = index;
      if ((messages[index].blocks ?? []).some((block) => block.kind === 'finalAnswer')) {
        lastCompletedAssistant = index;
        break;
      }
    }
  }
  const hasNewerIncompleteAssistant =
    lastCompletedAssistant >= 0 && lastAssistant > lastCompletedAssistant;
  const start = hasNewerIncompleteAssistant
    ? lastCompletedAssistant
    : lastAssistant >= 0
      ? lastAssistant
      : messages.length - 1;
  const end = hasNewerIncompleteAssistant ? lastCompletedAssistant + 1 : messages.length;
  return {
    messages: messages.slice(start, end),
    pageInfo: {
      hasMoreBefore: start > 0,
      startCursor: encodeTranscriptCursor(messages, sessionId, start),
      endCursor: encodeTranscriptCursor(messages, sessionId, end),
    },
  };
}

/**
 * Normalized rows are a presentation snapshot, not a recovery checkpoint.
 * Keep everything through the newest completed assistant turn, but do not
 * publish a later unfinished tool sequence. A session with no completed turn
 * still keeps its interrupted first turn so it remains recoverable in the UI.
 */
export function completedTranscriptSnapshot(messages: TranscriptMessage[]): TranscriptMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'assistant' &&
      (message.blocks ?? []).some((block) => block.kind === 'finalAnswer')
    ) {
      return messages.slice(0, index + 1);
    }
  }
  return messages;
}

/**
 * Identifies the exact completed transcript snapshot represented by normalized
 * rows. The digest intentionally excludes positional UI IDs: provider-history
 * compaction can renumber those IDs without changing the visible transcript.
 */
export function completedTranscriptRevision(messages: TranscriptMessage[]): string | null {
  const snapshot = completedTranscriptSnapshot(messages);
  const lastMessage = snapshot[snapshot.length - 1];
  if (
    !lastMessage ||
    lastMessage.role !== 'assistant' ||
    !(lastMessage.blocks ?? []).some((block) => block.kind === 'finalAnswer')
  ) {
    return null;
  }

  const canonical = snapshot.map((message) => ({
    role: message.role,
    text: message.text,
    blocks: (message.blocks ?? []).map((block) => ({
      kind: block.kind,
      text: block.text,
      activityId: block.activityId ?? null,
      activityPhase: block.activityPhase ?? null,
    })),
  }));
  return createHash('sha256')
    .update('completed-transcript-v1\0')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

export const FINAL_ANSWER_PREVIEW_CHARACTERS = 16_000;
export const ACTIVITY_PREVIEW_CHARACTERS = 12_000;

type ContentAddressableBlock = Pick<TranscriptBlock, 'kind' | 'text'>;

/**
 * Immutable identifier for deferred transcript content. Positional block IDs
 * can be reused when provider history is pruned and rebuilt; hashing the full
 * kind/body means an old preview can only resolve to identical content.
 */
export function transcriptContentId(block: ContentAddressableBlock): string {
  const hash = createHash('sha256');
  hash.update('transcript-content-v1');
  hash.update('\0');
  hash.update(block.kind);
  hash.update('\0');
  hash.update(block.text);
  return `content-${hash.digest('base64url')}`;
}

export function findTranscriptBlockContent(
  blocks: ContentAddressableBlock[],
  contentId: string,
): string | null {
  const block = blocks.find((candidate) => transcriptContentId(candidate) === contentId);
  return block?.text ?? null;
}

export function hasLegacyDeferredContentIds(messages: TranscriptMessage[]): boolean {
  return messages.some((message) =>
    (message.blocks ?? []).some(
      (block) =>
        block.isContentTruncated === true &&
        (typeof block.contentId !== 'string' || !block.contentId.startsWith('content-')),
    ),
  );
}

export function markdownBoundaryPreview(text: string, maximumCharacters: number): string {
  if (text.length <= maximumCharacters) return text;
  const lines = text.split(/(?<=\n)/);
  let length = 0;
  let inFence = false;
  let lastBoundary = 0;
  for (const line of lines) {
    if (length + line.length > maximumCharacters) break;
    length += line.length;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^\s*$/.test(line)) lastBoundary = length;
  }
  let safeLength =
    lastBoundary > 0 ? lastBoundary : length || Math.min(maximumCharacters, text.length);
  // Avoid ending between the UTF-16 halves of an emoji or other supplementary
  // scalar when a document has no Markdown boundary before the limit.
  if (safeLength > 0 && /[\uD800-\uDBFF]/.test(text[safeLength - 1])) safeLength -= 1;
  return text.slice(0, Math.max(1, safeLength)).trimEnd();
}

export function previewTranscript(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.map((message) => {
    const blocks = message.blocks?.map((block) => {
      const maximum =
        block.kind === 'finalAnswer'
          ? FINAL_ANSWER_PREVIEW_CHARACTERS
          : ACTIVITY_PREVIEW_CHARACTERS;
      if (block.text.length <= maximum) return block;
      return {
        ...block,
        text: markdownBoundaryPreview(block.text, maximum),
        contentLength: block.text.length,
        isContentTruncated: true,
        contentId: transcriptContentId(block),
      };
    });
    let finalText: string | undefined;
    for (let index = (blocks?.length ?? 0) - 1; index >= 0; index -= 1) {
      if (blocks?.[index].kind === 'finalAnswer') {
        finalText = blocks[index].text;
        break;
      }
    }
    const previewText =
      finalText ?? blocks?.map((block) => block.text).join('\n\n') ?? message.text;
    return { ...message, text: previewText, ...(blocks ? { blocks } : {}) };
  });
}

function contentToString(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function extractTaggedBlock(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function removeTaggedBlock(text: string, tag: string): string {
  const pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return text.replace(pattern, '');
}

// Detect whether any user message in the session's persisted history already
// contains a <project_context> block. We inject the project context only
// when NO past user message carries one — that way a session resumed AFTER
// it has been classified (started without a group, ended, got grouped by
// the cron, now resumed) still gets its first context injection. A session
// that already has the block in some earlier turn does not get duplicates.
export function userHistoryHasProjectContext(history: SessionState['history']): boolean {
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (/<project_context\b/i.test(text)) return true;
  }
  return false;
}

function cleanUserTranscriptText(text: string): string {
  return text
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/<user_steering[^>]*>([\s\S]*?)<\/user_steering>/gi, '$1')
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/<project_context[^>]*>[\s\S]*?<\/project_context>/gi, '')
    .replace(/@omniagent/gi, '')
    .trim();
}

function cleanAssistantTranscriptText(text: string): string {
  return text
    .replace(/<final_answer>([\s\S]*?)<\/final_answer>/gi, '$1')
    .replace(/<progress_summary[^>]*>([\s\S]*?)<\/progress_summary>/gi, '$1')
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/@omniagent/gi, '')
    .trim();
}

function terminalFeedbackText(text: string): string | null {
  let cleaned = text.trim();
  let isError = false;

  if (/^COMMAND ERROR:/i.test(cleaned)) {
    isError = true;
    cleaned = cleaned.replace(/^COMMAND ERROR:\s*/i, '').trim();
  }

  if (/^TERMINAL OUTPUT:/i.test(cleaned)) {
    cleaned = cleaned.replace(/^TERMINAL OUTPUT:\s*/i, '').trim();
  }

  if (!isError && cleaned === text.trim()) return null;

  return isError
    ? `Command error\n\n${cleaned || 'The command failed without output.'}`
    : cleaned || 'The command finished without output.';
}

function toolBlockKind(toolName?: string): HistoryBlockKind {
  if (!toolName) return 'agentReasoning';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcpCall';
  if (toolName === 'generate_image') return 'imageRendering';
  if (toolName === 'web_search' || toolName === 'web_fetch') return 'webCall';
  if (toolName === 'shell_script') return 'terminalOutput';
  return 'agentReasoning';
}

function toolInvocationKind(toolName?: string): HistoryBlockKind {
  if (!toolName) return 'agentReasoning';
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcpCall';
  if (toolName === 'generate_image') return 'imageRendering';
  if (toolName === 'web_search' || toolName === 'web_fetch') return 'webCall';
  if (toolName === 'shell_script') return 'shellCommand';
  return 'agentReasoning';
}

function toolInvocationText(call: unknown): { id?: string; name?: string; text: string } | null {
  if (!call || typeof call !== 'object') return null;
  const value = call as { id?: unknown; name?: unknown; arguments?: unknown };
  const id = typeof value.id === 'string' ? value.id : undefined;
  const name = typeof value.name === 'string' ? value.name : undefined;
  const args = value.arguments && typeof value.arguments === 'object' ? value.arguments : {};
  if (name === 'shell_script' && typeof (args as { script?: unknown }).script === 'string') {
    return { id, name, text: String((args as { script: string }).script) };
  }
  const serialized = JSON.stringify(args, null, 2);
  return { id, name, text: `Tool: ${name ?? 'unknown'}\n\nInput:\n${serialized}` };
}

function toolBlockText(toolName: string | undefined, content: string): string {
  const label = toolName ? `Tool: ${toolName}` : 'Tool result';
  return `${label}\n\n${content.trim() || 'No result text.'}`;
}

export function buildTranscript(raw: RawHistoryMessage[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let currentAssistant: TranscriptMessage | null = null;
  let blockCount = 0;
  let assistantCount = 0;

  const makeBlock = (
    kind: HistoryBlockKind,
    text: string,
    activityId?: string,
    activityPhase?: TranscriptBlock['activityPhase'],
  ): TranscriptBlock => ({
    id: `block-${blockCount++}`,
    kind,
    text,
    ...(activityId ? { activityId } : {}),
    ...(activityPhase ? { activityPhase } : {}),
  });

  const ensureAssistant = (): TranscriptMessage => {
    if (!currentAssistant) {
      currentAssistant = {
        id: `assistant-${assistantCount++}`,
        role: 'assistant',
        text: '',
        blocks: [],
      };
    }
    return currentAssistant;
  };

  const flushAssistant = () => {
    const blocks = currentAssistant?.blocks ?? [];
    if (!currentAssistant || !blocks.length) {
      currentAssistant = null;
      return;
    }

    let finalText = '';
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'finalAnswer') {
        finalText = blocks[i].text;
        break;
      }
    }

    currentAssistant.text =
      finalText ||
      blocks
        .map((b) => b.text)
        .join('\n\n')
        .trim();
    messages.push(currentAssistant);
    currentAssistant = null;
  };

  const appendAssistantBlock = (
    kind: HistoryBlockKind,
    text: string,
    activityId?: string,
    activityPhase?: TranscriptBlock['activityPhase'],
  ) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    ensureAssistant().blocks?.push(makeBlock(kind, cleaned, activityId, activityPhase));
  };

  raw.forEach((entry, index) => {
    const content = contentToString(entry.content);

    if (entry.role === 'system') return;

    if (entry.role === 'user') {
      // Server-injected recovery prompts live in the persisted history so the
      // model can react to them mid-turn, but they are not real user input and
      // must not surface in the resumed transcript.
      if (isInjectedUserPrompt(content)) return;

      const terminalText = terminalFeedbackText(content);
      if (terminalText) {
        appendAssistantBlock('terminalOutput', terminalText);
        return;
      }

      const userText = cleanUserTranscriptText(content);
      if (!userText) return;

      flushAssistant();
      messages.push({
        id: `${index}-user`,
        role: 'user',
        text: userText,
      });
      return;
    }

    if (entry.role === 'tool') {
      const failed = content.trimStart().startsWith('Error') || /^COMMAND ERROR:/i.test(content);
      appendAssistantBlock(
        toolBlockKind(entry.tool_name),
        toolBlockText(entry.tool_name, content),
        entry.tool_call_id,
        failed ? 'failed' : 'completed',
      );
      return;
    }

    if (entry.role !== 'assistant') return;

    const finalAnswer = extractTaggedBlock(content, 'final_answer');
    if (finalAnswer) {
      appendAssistantBlock('finalAnswer', finalAnswer);
      return;
    }

    const shellScript = extractTaggedBlock(content, 'shell_script');
    if (shellScript) {
      const reasoning = cleanAssistantTranscriptText(removeTaggedBlock(content, 'shell_script'));
      appendAssistantBlock('agentReasoning', reasoning);
      appendAssistantBlock('shellCommand', shellScript);
      return;
    }

    const hasToolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
    if (hasToolCalls) {
      // Only a deliberately tagged, user-visible progress report may enter
      // the timeline. Provider scratch text or hidden reasoning is discarded.
      const progressSummary = extractProgressSummary(content);
      appendAssistantBlock('agentReasoning', progressSummary ?? '');
      for (const rawCall of entry.tool_calls ?? []) {
        const call = toolInvocationText(rawCall);
        if (!call) continue;
        appendAssistantBlock(toolInvocationKind(call.name), call.text, call.id, 'started');
      }
      return;
    }
    const visible = cleanAssistantTranscriptText(content);
    if (!visible) return;
    appendAssistantBlock('finalAnswer', visible);
  });

  flushAssistant();
  return messages;
}
