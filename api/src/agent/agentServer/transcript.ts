import { MCP_TOOL_PREFIX } from '../mcpRuntime';
import { isInjectedUserPrompt } from '../injectedUserPrompts';
import type { SessionState } from '../types';

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
  tool_calls?: unknown[];
};

export type TranscriptBlock = {
  id: string;
  kind: HistoryBlockKind;
  text: string;
};

export type TranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  blocks?: TranscriptBlock[];
};

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
  return 'agentReasoning';
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

  const makeBlock = (kind: HistoryBlockKind, text: string): TranscriptBlock => ({
    id: `block-${blockCount++}`,
    kind,
    text,
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

  const appendAssistantBlock = (kind: HistoryBlockKind, text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    ensureAssistant().blocks?.push(makeBlock(kind, cleaned));
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
      appendAssistantBlock(toolBlockKind(entry.tool_name), toolBlockText(entry.tool_name, content));
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

    const visible = cleanAssistantTranscriptText(content);
    if (!visible) return;

    const hasToolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
    appendAssistantBlock(hasToolCalls ? 'agentReasoning' : 'finalAnswer', visible);
  });

  flushAssistant();
  return messages;
}
