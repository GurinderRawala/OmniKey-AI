import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Content, Tool as GeminiTool } from '@google/genai';
import cuid from 'cuid';
import { config } from './config';

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type AIProvider = 'openai' | 'gemini' | 'anthropic';

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
  openai: { fast: 'gpt-4o-mini', smart: 'gpt-5.1' },
  gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
  anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-4-6' },
};

export function getDefaultModel(provider: AIProvider, tier: 'fast' | 'smart'): string {
  return DEFAULT_MODELS[provider][tier];
}

/**
 * Maximum character length for a single message content string per provider.
 *
 * - anthropic: hard API-enforced string limit of 10,485,760 chars; we stay
 *              just below it with a small safety buffer.
 * - openai:    no documented per-string limit; bounded by the context window
 *              (~272K tokens for GPT-5.1 ≈ ~1M chars). Use the history cap.
 * - gemini:    no documented per-string limit; bounded by the 1M-token
 *              context window (~4M chars). Use the history cap.
 */
const MAX_MESSAGE_CONTENT_LENGTH_BY_PROVIDER: Record<AIProvider, number> = {
  anthropic: 10_000_000,
  openai: 800_000,
  gemini: 3_500_000,
};

/**
 * Maximum total character length across all messages in the conversation
 * history, derived from each provider's context-window size minus headroom
 * for the system prompt and max output tokens.
 *
 * - anthropic: Claude Sonnet 4.6 — 1M token ctx, 64K max output
 *              ≈ (1,000,000 - 64,000 - 10,000) tokens × 4 chars ≈ 3.7M chars
 * - openai:    GPT-5.1 — ~272K token ctx, ~32K max output
 *              ≈ (272,000 - 32,000 - 5,000) tokens × 4 chars ≈ 940K chars
 * - gemini:    Gemini 2.5 Pro — 1M token ctx, ~32K max output
 *              ≈ (1,000,000 - 32,000 - 10,000) tokens × 4 chars ≈ 3.8M chars
 */
const MAX_HISTORY_LENGTH_BY_PROVIDER: Record<AIProvider, number> = {
  anthropic: 3_500_000,
  openai: 800_000,
  gemini: 3_500_000,
};

export function getMaxMessageContentLength(provider: AIProvider): number {
  return MAX_MESSAGE_CONTENT_LENGTH_BY_PROVIDER[provider];
}

export function getMaxHistoryLength(provider: AIProvider): number {
  return MAX_HISTORY_LENGTH_BY_PROVIDER[provider];
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
      temperature: options.temperature ?? 0.2,
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
      temperature: options.temperature ?? 0.3,
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
      temperature: options.temperature ?? 0.2,
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
      temperature: options.temperature ?? 0.3,
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
        temperature: options.temperature ?? 0.2,
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
        temperature: options.temperature ?? 0.3,
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
  private anthropic?: AnthropicAdapter;
  private gemini?: GeminiAdapter;

  constructor(provider: AIProvider, apiKey: string) {
    this.provider = provider;
    if (provider === 'openai') {
      this.openai = new OpenAIAdapter(apiKey);
    } else if (provider === 'anthropic') {
      this.anthropic = new AnthropicAdapter(apiKey);
    } else if (provider === 'gemini') {
      this.gemini = new GeminiAdapter(apiKey);
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
    if (this.provider === 'openai' && this.openai) {
      return this.openai.complete(model, messages, options);
    }
    if (this.provider === 'anthropic' && this.anthropic) {
      return this.anthropic.complete(model, messages, options);
    }
    if (this.provider === 'gemini' && this.gemini) {
      return this.gemini.complete(model, messages, options);
    }
    throw new Error(`AI provider "${this.provider}" is not configured.`);
  }

  async streamComplete(
    model: string,
    messages: AIMessage[],
    options: CompletionOptions = {},
    onDelta: (delta: string) => void,
  ): Promise<{ usage?: AIUsage; model: string }> {
    if (this.provider === 'openai' && this.openai) {
      return this.openai.streamComplete(model, messages, options, onDelta);
    }
    if (this.provider === 'anthropic' && this.anthropic) {
      return this.anthropic.streamComplete(model, messages, options, onDelta);
    }
    if (this.provider === 'gemini' && this.gemini) {
      return this.gemini.streamComplete(model, messages, options, onDelta);
    }
    throw new Error(`AI provider "${this.provider}" is not configured.`);
  }

  /**
   * Generates an image with the currently configured provider.
   *
   * Supported providers are OpenAI and Gemini. Anthropic does not currently
   * expose a text-to-image generation endpoint in this project.
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

export const aiClient = new AIClient(config.aiProvider, config.aiApiKey);
