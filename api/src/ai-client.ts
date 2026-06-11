import * as https from 'https';
import { Readable } from 'stream';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Content, Tool as GeminiTool } from '@google/genai';
import cuid from 'cuid';
import { config } from './config';

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type AIProvider = 'openai' | 'gemini' | 'anthropic' | 'nemotron';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages when the model requested tool calls */
  tool_calls?: AIToolCall[];
  /** Present on tool-result messages — matches the id in the corresponding tool_call */
  tool_call_id?: string;
  /** Name of the tool that produced this result (used by some providers) */
  tool_name?: string;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AITool {
  name: string;
  description: string;
  /** JSON Schema object describing the function parameters */
  parameters: Record<string, unknown>;
}

export interface AIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AICompletionResult {
  content: string;
  finish_reason: 'stop' | 'tool_calls' | 'length';
  tool_calls?: AIToolCall[];
  usage?: AIUsage;
  model: string;
  /** Normalised assistant message ready to push into history */
  assistantMessage: AIMessage;
}

export interface CompletionOptions {
  temperature?: number;
  tools?: AITool[];
  maxTokens?: number;
}

/**
 * Normalized options for image generation across supported providers.
 */
export interface AIImageGenerateOptions {
  prompt: string;
  format?: 'png' | 'webp' | 'jpeg';
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  quality?: 'low' | 'medium' | 'high';
  background?: 'transparent' | 'opaque' | 'auto';
}

/**
 * Provider-agnostic image generation result.
 *
 * `imageBase64` contains raw image bytes encoded as base64 and is intended
 * to be persisted by callers (e.g. agent tools) to a local file.
 */
export interface AIImageGenerateResult {
  imageBase64: string;
  mimeType: string;
  provider: 'openai' | 'gemini';
  note?: string;
}

// ---------------------------------------------------------------------------
// Default model mapping
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<AIProvider, { fast: string; smart: string }> = {
  // Smart-tier picks track each provider's current flagship for
  // reasoning/coding workloads. Update here when a newer model becomes
  // generally available so both the feature routes and the agent server pick
  // it up automatically. When swapping a smart model in, also verify whether
  // it accepts the `temperature` parameter and update
  // `modelSupportsTemperature` accordingly.
  openai: { fast: 'gpt-4o-mini', smart: 'gpt-5.5' },
  gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
  anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-opus-4-7' },
  // NVIDIA Nemotron is exposed through the OpenAI-compatible NIM endpoint at
  // https://integrate.api.nvidia.com/v1. The "fast" tier maps to Nemotron Nano
  // for high-throughput sub-agent workloads; the "smart" tier maps to Nemotron
  // Ultra — the frontier-level model in the family — for complex multi-agent
  // reasoning, planning, code generation, and deep research. Drop down to
  // Nemotron Super (`nvidia/nemotron-3-super-120b-a12b`) here if single-GPU
  // data-center deployment is required.
  nemotron: {
    fast: 'nvidia/nemotron-3-nano-30b-a3b',
    smart: 'nvidia/nemotron-3-ultra-550b-a55b',
  },
};

export function getDefaultModel(provider: AIProvider, tier: 'fast' | 'smart'): string {
  // For the OpenAI smart tier, honour the user's OPENAI_MODEL selection from
  // config.json / env. The fast tier (gpt-4o-mini) is always fixed.
  if (tier === 'smart' && provider === 'openai' && config.openaiModel) {
    return config.openaiModel;
  }
  return DEFAULT_MODELS[provider][tier];
}

/**
 * Returns whether a given model accepts the `temperature` parameter.
 *
 * Provider-specific rules (validated against published API docs and SDKs as
 * of late 2025 / early 2026):
 *  - OpenAI GPT-5 family (`gpt-5`, `gpt-5-mini`, `gpt-5.1`, …): NOT supported.
 *    The API only accepts the default value (1) and returns
 *    `unsupported_value: 'temperature'` for anything else.
 *  - OpenAI o-series reasoning models (`o1`, `o3`, `o4-mini`, …): NOT
 *    supported for the same reason.
 *  - OpenAI GPT-4 / GPT-4o / GPT-3.5: supported.
 *  - Google Gemini (2.x and 3.x families): supported via `generationConfig`.
 *  - Anthropic Claude (Sonnet, Haiku, and Opus 4.x): supported, with the
 *    exception of `claude-opus-4-7` (and its dated revisions) which rejects
 *    `temperature` just like the OpenAI GPT-5 family.
 */
export function modelSupportsTemperature(model: string): boolean {
  // OpenAI GPT-5 family (gpt-5, gpt-5-mini, gpt-5.1, gpt-5.5, …) only
  // accepts the default temperature (1) — anything else is rejected with
  // `unsupported_value: 'temperature'`.
  if (/^gpt-5(\b|[.\-])/i.test(model)) return false;
  // OpenAI o-series reasoning models (o1, o3, o4-mini, …) likewise drop the
  // `temperature` knob.
  if (/^o[134](\b|[-_])/i.test(model)) return false;
  // Anthropic's Claude Opus 4.7 line (and its dated revisions like
  // `claude-opus-4-7-20260101`) does not accept `temperature`; the rest of
  // the Claude 4.x family (Sonnet, Haiku, Opus 4.5/4.6) does.
  if (/^claude-opus-4-7(\b|[-_])/i.test(model)) return false;
  return true;
}

/**
 * Maximum character length for a single message content string per provider.
 *
 * - anthropic: hard API-enforced string limit of 10,485,760 chars; we stay
 *              just below it with a small safety buffer.
 * - openai:    no documented per-string limit; gpt-5.5 (Responses API) has a
 *              1M-token context window. Use the history cap.
 * - gemini:    no documented per-string limit; bounded by the 1M-token
 *              context window (~4M chars). Use the history cap.
 */
const MAX_MESSAGE_CONTENT_LENGTH_BY_PROVIDER: Record<AIProvider, number> = {
  anthropic: 10_000_000,
  openai: 3_500_000,
  gemini: 3_500_000,
  // Nemotron 3 ships a 1M-token context window via NIM; mirror Gemini's
  // per-string cap (no documented hard limit, bounded by the context window).
  nemotron: 3_500_000,
};

/**
 * Maximum total character length across all messages in the conversation
 * history. Uses 2 chars/token (conservative) instead of 4 to account for
 * content with low chars-per-token ratios (JSON, code, tool results).
 *
 * - anthropic: 1M token ctx, reserve 100K for output + system prompt
 *              → 900K target tokens × 2 chars ≈ 1.8M chars
 * - openai:    1M token ctx (gpt-5.5 Responses API), reserve 100K
 *              → 900K target tokens × 2 chars ≈ 1.8M chars
 * - gemini:    1M token ctx, reserve 100K
 *              → 900K target tokens × 2 chars ≈ 1.8M chars
 */
const MAX_HISTORY_LENGTH_BY_PROVIDER: Record<AIProvider, number> = {
  anthropic: 1_800_000,
  openai: 1_800_000,
  gemini: 1_800_000,
  // 1M-token context with 100K reserved for output → 900K target × 2 chars
  nemotron: 1_800_000,
};

/**
 * Hard token limit of the context window for each provider/model tier.
 * Used to compute the accurate "tokens remaining" value shown in the UI.
 */
const CONTEXT_WINDOW_BY_PROVIDER: Record<AIProvider, number> = {
  anthropic: 1_000_000,
  openai: 1_000_000,
  gemini: 1_000_000,
  // Nemotron 3 hybrid Mamba-Transformer MoE family ships with 1M-token context.
  nemotron: 1_000_000,
};

export function getMaxMessageContentLength(provider: AIProvider): number {
  return MAX_MESSAGE_CONTENT_LENGTH_BY_PROVIDER[provider];
}

export function getMaxHistoryLength(provider: AIProvider): number {
  return MAX_HISTORY_LENGTH_BY_PROVIDER[provider];
}

export function getContextWindowSize(provider: AIProvider): number {
  return CONTEXT_WINDOW_BY_PROVIDER[provider];
}

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

class OpenAIAdapter {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
  ): Promise<AICompletionResult> {
    const oaiMessages = toOpenAIMessages(messages);
    const tools = options.tools?.length ? toOpenAITools(options.tools) : undefined;

    const completion = await this.client.chat.completions.create({
      model,
      messages: oaiMessages,
      tools: tools?.length ? tools : undefined,
      ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.2 } : {}),
      max_tokens: options.maxTokens,
    });

    const choice = completion.choices[0];
    const msg = choice.message;
    const content = (msg.content ?? '').toString().trim();

    const tool_calls: AIToolCall[] | undefined = msg.tool_calls
      ?.filter(
        (
          tc,
        ): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
          type: 'function';
          function: { name: string; arguments: string };
        } => tc.type === 'function' && 'function' in tc,
      )
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
      }));

    const finishReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : 'stop';

    const usage = completion.usage
      ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens: completion.usage.total_tokens,
        }
      : undefined;

    const assistantMessage: AIMessage = {
      role: 'assistant',
      content,
      ...(tool_calls?.length ? { tool_calls } : {}),
    };

    return { content, finish_reason: finishReason, tool_calls, usage, model, assistantMessage };
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    const oaiMessages = toOpenAIMessages(messages);

    const stream = await this.client.chat.completions.create({
      model,
      messages: oaiMessages,
      ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.3 } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage: AIUsage | undefined;

    for await (const part of stream as AsyncIterable<any>) {
      const delta = part.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        onDelta(delta);
      }
      if (part.usage) {
        usage = {
          prompt_tokens: part.usage.prompt_tokens ?? 0,
          completion_tokens: part.usage.completion_tokens ?? 0,
          total_tokens: part.usage.total_tokens ?? 0,
        };
      }
    }

    return { usage, model };
  }

  /**
   * Generates an image using OpenAI and returns base64 image bytes.
   *
   * @param options - Unified image-generation options.
   * @returns Provider-normalized image payload.
   */
  async generateImage(options: AIImageGenerateOptions): Promise<AIImageGenerateResult> {
    const format = options.format ?? 'png';
    const size = options.size ?? '1024x1024';
    const quality = options.quality ?? 'medium';
    const background = options.background ?? 'auto';

    const response: any = await this.client.images.generate({
      model: 'gpt-image-1',
      prompt: options.prompt,
      size,
      quality,
      background,
      output_format: format,
    });

    const b64 = response?.data?.[0]?.b64_json;
    if (!b64 || typeof b64 !== 'string') {
      throw new Error('OpenAI image generation returned no image data');
    }

    const mimeType =
      format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    return { imageBase64: b64, mimeType, provider: 'openai' };
  }
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

class AnthropicAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
  ): Promise<AICompletionResult> {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const tools = options.tools?.length ? toAnthropicTools(options.tools) : undefined;

    const response = await this.client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 8192,
      ...(system ? { system } : {}),
      messages: anthropicMessages,
      ...(tools?.length ? { tools } : {}),
      ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.2 } : {}),
    });

    const textContent = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('');

    const tool_calls: AIToolCall[] | undefined = response.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const tu = b as Anthropic.ToolUseBlock;
        return {
          id: tu.id,
          name: tu.name,
          arguments: tu.input as Record<string, unknown>,
        };
      });

    const finishReason =
      response.stop_reason === 'tool_use'
        ? 'tool_calls'
        : response.stop_reason === 'max_tokens'
          ? 'length'
          : 'stop';

    const usage: AIUsage = {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    const assistantMessage: AIMessage = {
      role: 'assistant',
      content: textContent,
      ...(tool_calls?.length ? { tool_calls } : {}),
    };

    return {
      content: textContent,
      finish_reason: finishReason,
      tool_calls: tool_calls?.length ? tool_calls : undefined,
      usage,
      model,
      assistantMessage,
    };
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

    const stream = this.client.messages.stream({
      model,
      max_tokens: options.maxTokens ?? 8192,
      ...(system ? { system } : {}),
      messages: anthropicMessages,
      ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.3 } : {}),
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text
      ) {
        onDelta(event.delta.text);
      }
    }

    const finalMsg = await stream.finalMessage();
    const usage: AIUsage = {
      prompt_tokens: finalMsg.usage.input_tokens,
      completion_tokens: finalMsg.usage.output_tokens,
      total_tokens: finalMsg.usage.input_tokens + finalMsg.usage.output_tokens,
    };

    return { usage, model };
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses API adapter
// ---------------------------------------------------------------------------

/**
 * GPT-5.5 should be routed through OpenAI's Responses API rather than Chat
 * Completions so it can use native function-calling semantics.
 */
export const RESPONSES_API_MODEL = 'gpt-5.5';

/**
 * Translates our generic AIMessage[] history into the Responses API input
 * format.
 *
 * Key translation rules:
 * - system  → top-level `instructions` string (concatenated if multiple)
 * - user    → EasyInputMessage { role:'user', content }
 *   - "TERMINAL OUTPUT:" / "COMMAND ERROR:" messages that follow a shell call
 *     are re-emitted as function_call_output items so the model sees the result
 *     against the correct call_id.
 * - assistant with tool_calls → text part (if any) + one function_call per tool
 * - assistant with <shell_script> tag → synthetic function_call for
 *   execute_shell_script (so history from prior turns round-trips correctly)
 * - tool role → function_call_output
 */
function toResponsesInput(messages: AIMessage[]): {
  instructions: string | null;
  input: any[];
} {
  let instructions: string | null = null;
  const input: any[] = [];
  let pendingShellCallId: string | null = null;
  let syntheticCounter = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      instructions = instructions ? `${instructions}\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'user') {
      const isTerminalFeedback = /^(TERMINAL OUTPUT:|COMMAND ERROR:)/i.test(
        msg.content.trimStart(),
      );
      if (pendingShellCallId && isTerminalFeedback) {
        const output = msg.content.replace(/^(TERMINAL OUTPUT:|COMMAND ERROR:)\s*/i, '').trim();
        input.push({
          type: 'function_call_output',
          call_id: pendingShellCallId,
          output: output || '(no output)',
        });
        pendingShellCallId = null;
        continue;
      }
      // A shell_script function_call was emitted but terminal output never
      // arrived (e.g. the client disconnected before executing the script).
      // Emit a synthetic result so the Responses API input remains valid.
      if (pendingShellCallId) {
        input.push({
          type: 'function_call_output',
          call_id: pendingShellCallId,
          output: '(no terminal output received — session was interrupted)',
        });
        pendingShellCallId = null;
      }
      input.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      // Same gap-fill: if the previous shell call never got a terminal result,
      // plug it before the next assistant message.
      if (pendingShellCallId) {
        input.push({
          type: 'function_call_output',
          call_id: pendingShellCallId,
          output: '(no terminal output received — session was interrupted)',
        });
        pendingShellCallId = null;
      }

      if (msg.tool_calls?.length) {
        if (msg.content) {
          input.push({ role: 'assistant', content: msg.content });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
      } else if (msg.content.includes('<shell_script>')) {
        // Round-trip: a prior <shell_script> turn becomes a native function_call
        // so the model sees it as a proper tool invocation in the history.
        const scriptMatch = msg.content.match(/<shell_script>([\s\S]*?)<\/shell_script>/i);
        const script = scriptMatch?.[1]?.trim() ?? msg.content;
        const beforeShell = msg.content.split('<shell_script>')[0].trim();
        if (beforeShell) {
          input.push({ role: 'assistant', content: beforeShell });
        }
        const callId = `synth_shell_${++syntheticCounter}`;
        pendingShellCallId = callId;
        input.push({
          type: 'function_call',
          call_id: callId,
          name: 'execute_shell_script',
          arguments: JSON.stringify({ script }),
        });
      } else {
        input.push({ role: 'assistant', content: msg.content });
      }
      continue;
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      pendingShellCallId = null;
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: msg.content,
      });
      continue;
    }
  }

  // If the history ends with a shell_script call that never received terminal
  // output (the session was cut off at the very last turn), close the gap.
  if (pendingShellCallId) {
    input.push({
      type: 'function_call_output',
      call_id: pendingShellCallId,
      output: '(no terminal output received — session was interrupted)',
    });
  }

  return { instructions, input };
}

/**
 * Translates our AITool[] definition list into the Responses API FunctionTool
 * format. The outer shape differs from Chat Completions: here `name`,
 * `description`, and `parameters` sit at the top level (not nested under
 * `function`).
 */
function toResponsesTools(tools: AITool[]): any[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters as { [key: string]: unknown },
    strict: false,
  }));
}

/**
 * Native function tool exposed to gpt-5.5 / Responses API so the model can
 * run shell commands using tool-call syntax instead of XML tags. The adapter
 * intercepts calls to this tool and converts them to the <shell_script> tag
 * format that the rest of the agent pipeline expects.
 */
const RESPONSES_SHELL_TOOL = {
  type: 'function' as const,
  name: 'execute_shell_script',
  description:
    'Execute shell commands to accomplish the task. Use this to run terminal commands, read or write files, install packages, or perform system operations. The output will be returned to you automatically.',
  parameters: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'The shell script to execute' },
    },
    required: ['script'],
  },
  strict: false,
};

/**
 * Translates a Responses API response object into our normalised
 * AICompletionResult.
 *
 * Priority order for output classification:
 * 1. execute_shell_script function_call → wrap script in <shell_script> tags,
 *    return finish_reason:'stop' so agentServer sends it to the client.
 * 2. Other function_calls → return as tool_calls (MCP/web-search loop).
 * 3. Text that already contains <shell_script> or <final_answer> tags → pass through.
 * 4. Plain text with no recognized tags → auto-wrap in <final_answer> tags so
 *    the agent loop does not spin trying to coerce the model into using tags.
 */
function fromResponsesOutput(response: any, modelName: string): AICompletionResult {
  const output: any[] = response.output ?? [];

  const textContent: string = output
    .filter((item: any) => item.type === 'message')
    .flatMap((item: any) => item.content ?? [])
    .filter((c: any) => c.type === 'output_text')
    .map((c: any) => (c.text ?? '') as string)
    .join('');

  const functionCalls: any[] = output.filter((item: any) => item.type === 'function_call');

  // 1. Shell tool call → convert to <shell_script> content
  const shellCall = functionCalls.find((f) => f.name === 'execute_shell_script');
  if (shellCall) {
    let script = '';
    try {
      script = JSON.parse(shellCall.arguments || '{}').script ?? '';
    } catch {
      script = shellCall.arguments ?? '';
    }
    const shellContent = `<shell_script>\n${script}\n</shell_script>`;
    const usage: AIUsage | undefined = response.usage
      ? {
          prompt_tokens: response.usage.input_tokens ?? 0,
          completion_tokens: response.usage.output_tokens ?? 0,
          total_tokens: response.usage.total_tokens ?? 0,
        }
      : undefined;
    return {
      content: shellContent,
      finish_reason: 'stop',
      usage,
      model: response.model ?? modelName,
      assistantMessage: { role: 'assistant', content: shellContent },
    };
  }

  // 2. Other function calls (MCP tools, web search, etc.)
  const tool_calls: AIToolCall[] = functionCalls.map((item: any) => ({
    id: item.call_id as string,
    name: item.name as string,
    arguments: JSON.parse(item.arguments || '{}') as Record<string, unknown>,
  }));

  const hasRecognizedTags =
    /<shell_script>/i.test(textContent) || /<final_answer>/i.test(textContent);

  // 4. Auto-wrap plain text that has no recognized tags
  const normalizedContent =
    tool_calls.length === 0 && textContent && !hasRecognizedTags
      ? `<final_answer>\n${textContent}\n</final_answer>`
      : textContent;

  const finishReason: 'stop' | 'tool_calls' | 'length' =
    tool_calls.length > 0 ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop';

  const usage: AIUsage | undefined = response.usage
    ? {
        prompt_tokens: response.usage.input_tokens ?? 0,
        completion_tokens: response.usage.output_tokens ?? 0,
        total_tokens: response.usage.total_tokens ?? 0,
      }
    : undefined;

  const assistantMessage: AIMessage = {
    role: 'assistant',
    content: normalizedContent,
    ...(tool_calls.length ? { tool_calls } : {}),
  };

  return {
    content: normalizedContent,
    finish_reason: finishReason,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    usage,
    model: response.model ?? modelName,
    assistantMessage,
  };
}

/**
 * Appended to the system instructions when using the Responses API so that
 * gpt-5.5 (a reasoning model) calls execute_shell_script rather than the
 * shell_script tool used by other providers. The Responses API adapter
 * translates execute_shell_script calls back to the standard shell_script
 * format understood by the rest of the agent pipeline.
 */
const RESPONSES_SHELL_OVERRIDE = `
---
IMPORTANT — Responses API adjustment (one change only):

You are running via the OpenAI Responses API. **Only one thing changes** from the instructions above:

- **Shell commands**: instead of calling the \`shell_script\` tool, call the \`execute_shell_script\` function tool with \`{ "script": "..." }\`. The interface is identical — the output is returned to you automatically as a tool result. Every other rule about when and how to run scripts is unchanged.

Everything else in the system prompt applies exactly as written:
- \`web_search\` / \`web_fetch\` → native function calls (unchanged)
- MCP tools (\`mcp_<server>__<tool>\`) → native function calls, subject to all MCP rules above (unchanged)
- \`<final_answer>\` → text response wrapped in \`<final_answer>\` tags (unchanged)
`;

/**
 * Fetch wrapper backed by Node's https module (HTTP/1.1 only).
 *
 * Node's built-in fetch uses undici which maintains a global HTTP/2 session
 * pool. When a session is destroyed after an idle period the very next request
 * on the same pool throws ERR_HTTP2_INVALID_SESSION. Because the pool is
 * global, creating a new OpenAI() client doesn't help — it still reuses the
 * stale session. Using https.request forces HTTP/1.1 and bypasses undici
 * entirely, eliminating the error at its root.
 */
async function http1Fetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> {
  const urlStr =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const url = new URL(urlStr);

  const method =
    init?.method ?? (input instanceof Request ? (input as Request).method : 'GET');

  const rawHeaders: Record<string, string> = {};
  if (input instanceof Request) {
    (input as Request).headers.forEach((v: string, k: string) => {
      rawHeaders[k] = v;
    });
  }
  const ih = init?.headers;
  if (ih) {
    if (ih instanceof Headers) {
      ih.forEach((v, k) => { rawHeaders[k] = v; });
    } else if (Array.isArray(ih)) {
      for (const [k, v] of ih) rawHeaders[k] = v;
    } else {
      Object.assign(rawHeaders, ih as Record<string, string>);
    }
  }

  const bodySource =
    init?.body ?? (input instanceof Request ? (input as Request).body : null);
  let bodyBuf: Buffer | null = null;
  if (bodySource != null) {
    if (typeof bodySource === 'string') {
      bodyBuf = Buffer.from(bodySource, 'utf8');
    } else if (Buffer.isBuffer(bodySource)) {
      bodyBuf = bodySource as Buffer;
    } else if (bodySource instanceof Uint8Array) {
      bodyBuf = Buffer.from(bodySource);
    } else if (typeof (bodySource as any)[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      for await (const chunk of bodySource as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      bodyBuf = Buffer.concat(chunks);
    }
    if (bodyBuf && !rawHeaders['content-length']) {
      rawHeaders['content-length'] = String(bodyBuf.length);
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + url.search,
        method,
        headers: rawHeaders,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v != null) {
            responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
          }
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on('error', reject);

    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      req.destroy();
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => {
      req.destroy();
      reject(new DOMException('The operation was aborted', 'AbortError'));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

class OpenAIResponsesAdapter {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, fetch: http1Fetch as unknown as typeof fetch });
  }

  private buildInstructions(base: string | null): string {
    return (base ?? '') + RESPONSES_SHELL_OVERRIDE;
  }

  async complete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
  ): Promise<AICompletionResult> {
    const { instructions, input } = toResponsesInput(messages);
    // Always inject the shell tool so gpt-5.5 can call execute_shell_script
    // natively; the adapter converts those calls back to <shell_script> tags.
    const userTools = options.tools?.length ? toResponsesTools(options.tools) : [];
    const tools = [RESPONSES_SHELL_TOOL, ...userTools];

    const response = await (this.client.responses as any).create({
      model,
      instructions: this.buildInstructions(instructions),
      input,
      tools,
    });
    return fromResponsesOutput(response, model);
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    _options: CompletionOptions,
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    const { instructions, input } = toResponsesInput(messages);

    const stream = (this.client.responses as any).stream({
      model,
      instructions: this.buildInstructions(instructions),
      input,
    });

    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'response.output_text.delta' && event.delta) {
        onDelta(event.delta as string);
      }
    }

    let usage: AIUsage | undefined;
    try {
      const finalResponse = await stream.finalResponse();
      if (finalResponse?.usage) {
        usage = {
          prompt_tokens: finalResponse.usage.input_tokens ?? 0,
          completion_tokens: finalResponse.usage.output_tokens ?? 0,
          total_tokens: finalResponse.usage.total_tokens ?? 0,
        };
      }
    } catch {
      // finalResponse may throw if the stream was already consumed
    }

    return { usage, model };
  }
}

// ---------------------------------------------------------------------------
// Nemotron adapter (NVIDIA NIM — OpenAI-compatible REST API)
// ---------------------------------------------------------------------------

/**
 * NVIDIA Nemotron models are served behind an OpenAI-compatible endpoint at
 * `https://integrate.api.nvidia.com/v1` (the NVIDIA NIM gateway, also used by
 * self-hosted NIM microservices). Because the wire protocol matches OpenAI's
 * Chat Completions API, we reuse the `openai` SDK by constructing a client
 * with a custom `baseURL`. This keeps the message/tool-call conversion logic
 * identical to OpenAI and avoids pulling in another transport library.
 *
 * Notes on Nemotron-specific quirks:
 *  - The endpoint accepts `temperature`, `top_p`, `max_tokens`, and `tools`
 *    in the standard OpenAI shape, so no schema translation is needed.
 *  - Image generation is not exposed for the text-only Nemotron models, so
 *    `generateImage` is intentionally not implemented (the unified `AIClient`
 *    surfaces a clear error for unsupported providers).
 *  - Self-hosted NIM deployments can be targeted by setting the
 *    `NEMOTRON_BASE_URL` env var (handled in `config.ts`). The API key can be
 *    any non-empty string for self-hosted NIM.
 */
class NemotronAdapter {
  private client: OpenAI;

  constructor(apiKey: string, baseURL: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async complete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
  ): Promise<AICompletionResult> {
    const oaiMessages = toOpenAIMessages(messages);
    const tools = options.tools?.length ? toOpenAITools(options.tools) : undefined;

    const completion = await this.client.chat.completions.create({
      model,
      messages: oaiMessages,
      tools: tools?.length ? tools : undefined,
      ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.2 } : {}),
      max_tokens: options.maxTokens,
    });

    const choice = completion.choices[0];
    const msg = choice.message;
    const content = (msg.content ?? '').toString().trim();

    const tool_calls: AIToolCall[] | undefined = msg.tool_calls
      ?.filter(
        (
          tc,
        ): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
          type: 'function';
          function: { name: string; arguments: string };
        } => tc.type === 'function' && 'function' in tc,
      )
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
      }));

    const finishReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : 'stop';

    const usage = completion.usage
      ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens: completion.usage.total_tokens,
        }
      : undefined;

    const assistantMessage: AIMessage = {
      role: 'assistant',
      content,
      ...(tool_calls?.length ? { tool_calls } : {}),
    };

    return { content, finish_reason: finishReason, tool_calls, usage, model, assistantMessage };
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    const oaiMessages = toOpenAIMessages(messages);

    const stream = await this.client.chat.completions.create({
      model,
      messages: oaiMessages,
      ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.3 } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage: AIUsage | undefined;

    for await (const part of stream as AsyncIterable<any>) {
      const delta = part.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        onDelta(delta);
      }
      if (part.usage) {
        usage = {
          prompt_tokens: part.usage.prompt_tokens ?? 0,
          completion_tokens: part.usage.completion_tokens ?? 0,
          total_tokens: part.usage.total_tokens ?? 0,
        };
      }
    }

    return { usage, model };
  }
}

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

class GeminiAdapter {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async complete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
  ): Promise<AICompletionResult> {
    const { systemInstruction, contents } = toGeminiContents(messages);
    const tools = options.tools?.length ? toGeminiTools(options.tools) : undefined;

    const response = await this.client.models.generateContent({
      model,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.2 } : {}),
      },
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const textContent = parts
      .filter((p) => p.text != null)
      .map((p) => p.text ?? '')
      .join('');

    const functionCalls = parts.filter((p) => p.functionCall != null);
    const tool_calls: AIToolCall[] | undefined = functionCalls.length
      ? functionCalls.map((p) => ({
          id: cuid(),
          name: p.functionCall!.name ?? '',
          arguments: (p.functionCall!.args ?? {}) as Record<string, unknown>,
        }))
      : undefined;

    const finishReason =
      candidate?.finishReason === 'MAX_TOKENS'
        ? 'length'
        : tool_calls?.length
          ? 'tool_calls'
          : 'stop';

    const usageMeta = response.usageMetadata;
    const usage: AIUsage | undefined = usageMeta
      ? {
          prompt_tokens: usageMeta.promptTokenCount ?? 0,
          completion_tokens: usageMeta.candidatesTokenCount ?? 0,
          total_tokens: usageMeta.totalTokenCount ?? 0,
        }
      : undefined;

    const assistantMessage: AIMessage = {
      role: 'assistant',
      content: textContent,
      ...(tool_calls?.length ? { tool_calls } : {}),
    };

    return {
      content: textContent,
      finish_reason: finishReason,
      tool_calls,
      usage,
      model,
      assistantMessage,
    };
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions,
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    const { systemInstruction, contents } = toGeminiContents(messages);

    const stream = await this.client.models.generateContentStream({
      model,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(modelSupportsTemperature(model) ? { temperature: options.temperature ?? 0.3 } : {}),
      },
    });

    let usage: AIUsage | undefined;

    for await (const chunk of stream) {
      const text = chunk.text ?? '';
      if (text) {
        onDelta(text);
      }
      if (chunk.usageMetadata) {
        usage = {
          prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
        };
      }
    }

    return { usage, model };
  }

  /**
   * Generates an image using Gemini Imagen and returns base64 image bytes.
   *
   * @param options - Unified image-generation options.
   * @returns Provider-normalized image payload and optional compatibility note.
   */
  async generateImage(options: AIImageGenerateOptions): Promise<AIImageGenerateResult> {
    const requestedFormat = options.format ?? 'png';
    const size = options.size ?? '1024x1024';
    const quality = options.quality ?? 'medium';

    const aspectRatio = size === '1024x1536' ? '2:3' : size === '1536x1024' ? '3:2' : '1:1';

    // Imagen in this SDK path supports png/jpeg output directly. WebP requests
    // are downgraded to PNG and surfaced with a note.
    const outputMimeType = requestedFormat === 'jpeg' ? 'image/jpeg' : 'image/png';

    const response = await this.client.models.generateImages({
      model: 'imagen-4.0-generate-001',
      prompt: options.prompt,
      config: {
        numberOfImages: 1,
        aspectRatio,
        outputMimeType,
        guidanceScale: quality === 'high' ? 8 : quality === 'low' ? 5 : 6.5,
      },
    });

    const generated = response.generatedImages?.[0]?.image;
    const imageBase64 = generated?.imageBytes;
    if (!imageBase64) {
      throw new Error('Gemini image generation returned no image data');
    }

    const mimeType = generated?.mimeType || outputMimeType;
    const note =
      requestedFormat === 'webp'
        ? 'Gemini does not currently return WebP in this path; image was generated as PNG.'
        : undefined;

    return { imageBase64, mimeType, provider: 'gemini', note };
  }
}

// ---------------------------------------------------------------------------
// Main AIClient
// ---------------------------------------------------------------------------

export class AIClient {
  private provider: AIProvider;
  private openai?: OpenAIAdapter;
  private openaiResponses?: OpenAIResponsesAdapter;
  private anthropic?: AnthropicAdapter;
  private gemini?: GeminiAdapter;
  private nemotron?: NemotronAdapter;

  constructor(provider: AIProvider, apiKey: string, options: { nemotronBaseURL?: string } = {}) {
    this.provider = provider;
    if (provider === 'openai') {
      // Instantiate both adapters so routing can be selected per request. GPT-5.5
      // must use Responses API, while GPT-5.1 and older chat models continue to
      // use Chat Completions.
      this.openaiResponses = new OpenAIResponsesAdapter(apiKey);
      this.openai = new OpenAIAdapter(apiKey);
    } else if (provider === 'anthropic') {
      this.anthropic = new AnthropicAdapter(apiKey);
    } else if (provider === 'gemini') {
      this.gemini = new GeminiAdapter(apiKey);
    } else if (provider === 'nemotron') {
      // Default to the public NVIDIA NIM gateway. Self-hosted NIM deployments
      // can override this via `NEMOTRON_BASE_URL` (see config.ts).
      const baseURL = options.nemotronBaseURL || 'https://integrate.api.nvidia.com/v1';
      this.nemotron = new NemotronAdapter(apiKey, baseURL);
    }
  }

  getProvider(): AIProvider {
    return this.provider;
  }

  async complete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions = {},
  ): Promise<AICompletionResult> {
    if (this.provider === 'openai' && model === RESPONSES_API_MODEL && this.openaiResponses) {
      return this.openaiResponses.complete(model, messages, options);
    }
    if (this.provider === 'openai' && this.openai) {
      return this.openai.complete(model, messages, options);
    }
    if (this.provider === 'anthropic' && this.anthropic) {
      return this.anthropic.complete(model, messages, options);
    }
    if (this.provider === 'gemini' && this.gemini) {
      return this.gemini.complete(model, messages, options);
    }
    if (this.provider === 'nemotron' && this.nemotron) {
      return this.nemotron.complete(model, messages, options);
    }
    throw new Error(`AI provider "${this.provider}" is not configured.`);
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions = {},
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    if (this.provider === 'openai' && model === RESPONSES_API_MODEL && this.openaiResponses) {
      return this.openaiResponses.streamComplete(model, messages, options, onDelta);
    }
    if (this.provider === 'openai' && this.openai) {
      return this.openai.streamComplete(model, messages, options, onDelta);
    }
    if (this.provider === 'anthropic' && this.anthropic) {
      return this.anthropic.streamComplete(model, messages, options, onDelta);
    }
    if (this.provider === 'gemini' && this.gemini) {
      return this.gemini.streamComplete(model, messages, options, onDelta);
    }
    if (this.provider === 'nemotron' && this.nemotron) {
      return this.nemotron.streamComplete(model, messages, options, onDelta);
    }
    throw new Error(`AI provider "${this.provider}" is not configured.`);
  }

  /**
   * Reports whether the configured provider can generate images.
   *
   * Centralising this check means agent tool registration and system-prompt
   * builders no longer need to keep a hand-maintained allow/deny list of
   * providers — they ask the client directly. Currently OpenAI and Gemini
   * support image generation; Anthropic and Nemotron (text-only) do not.
   */
  supportsImageGeneration(): boolean {
    return this.provider === 'openai' || this.provider === 'gemini';
  }

  /**
   * Generates an image with the currently configured provider.
   *
   * Supported providers are OpenAI and Gemini. Anthropic and Nemotron do not
   * currently expose a text-to-image generation endpoint in this project.
   *
   * @param options - Unified image-generation options.
   * @returns Provider-normalized image payload.
   */
  async generateImage(options: AIImageGenerateOptions): Promise<AIImageGenerateResult> {
    if (this.provider === 'openai' && this.openai) {
      return this.openai.generateImage(options);
    }
    if (this.provider === 'gemini' && this.gemini) {
      return this.gemini.generateImage(options);
    }
    throw new Error(`Image generation is not supported for provider "${this.provider}".`);
  }
}

/**
 * Returns whether the given provider supports image generation.
 *
 * Module-level helper for callers that only have the provider id at hand
 * (e.g. system-prompt builders) and don't want to construct an `AIClient`.
 */
export function providerSupportsImageGeneration(provider: AIProvider): boolean {
  return provider === 'openai' || provider === 'gemini';
}

// ---------------------------------------------------------------------------
// Message format converters — OpenAI
// ---------------------------------------------------------------------------

function toOpenAIMessages(
  messages: AIMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      result.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      });
    }
  }
  return result;
}

function toOpenAITools(tools: AITool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));
}

// ---------------------------------------------------------------------------
// Message format converters — Anthropic
// ---------------------------------------------------------------------------

type AnthropicMessageParam = Anthropic.MessageParam;

function toAnthropicMessages(messages: AIMessage[]): {
  system: string | undefined;
  messages: AnthropicMessageParam[];
} {
  let system: string | undefined;
  const result: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic takes system as a top-level param; concatenate if multiple
      system = system ? `${system}\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      // Tool results must go into the user role
      const prev = result[result.length - 1];
      const toolResult: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      };
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
        (prev.content as Anthropic.ContentBlockParam[]).push(toolResult);
      } else {
        result.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }

    result.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    });
  }

  return { system, messages: result };
}

function toAnthropicTools(tools: AITool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

// ---------------------------------------------------------------------------
// Message format converters — Gemini
// ---------------------------------------------------------------------------

function toGeminiContents(messages: AIMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = systemInstruction ? `${systemInstruction}\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      // Tool responses go as user messages with functionResponse parts
      const prev = contents[contents.length - 1];
      const responsePart = {
        functionResponse: {
          name: msg.tool_name ?? 'tool',
          response: { result: msg.content },
        },
      };
      if (prev && prev.role === 'user') {
        prev.parts = [...(prev.parts ?? []), responsePart];
      } else {
        contents.push({ role: 'user', parts: [responsePart] });
      }
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const parts = msg.tool_calls.map((tc) => ({
        functionCall: { name: tc.name, args: tc.arguments },
      }));
      if (msg.content) {
        parts.unshift({ functionCall: undefined, text: msg.content } as any);
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: msg.content }] });
  }

  return { systemInstruction, contents };
}

function toGeminiTools(tools: AITool[]): GeminiTool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as any,
      })),
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared singleton — import this instead of constructing a new AIClient
// ---------------------------------------------------------------------------

export const aiClient = new AIClient(config.aiProvider, config.aiApiKey, {
  nemotronBaseURL: config.nemotronBaseUrl,
});
