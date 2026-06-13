/**
 * Per-provider adapter tests for temperature handling.
 *
 * The three SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`) are mocked
 * at the module boundary using `vi.mock`. Mock spies are declared inside a
 * `vi.hoisted()` block so they are available when `vi.mock` factories run
 * (vi.mock is hoisted to the top of the file).
 *
 * These tests never contact any real API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  responsesCreate: vi.fn(),
  responsesStream: vi.fn(),
  anthropicCreate: vi.fn(),
  anthropicStream: vi.fn(),
  geminiGenerate: vi.fn(),
  geminiGenerateStream: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.openaiCreate } };
    responses = { create: mocks.responsesCreate, stream: mocks.responsesStream };
    images = { generate: vi.fn() };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mocks.anthropicCreate, stream: mocks.anthropicStream };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContent: mocks.geminiGenerate,
      generateContentStream: mocks.geminiGenerateStream,
      generateImages: vi.fn(),
    };
    constructor(_opts: unknown) {}
  },
  // The adapter file imports these as types-only but they still need to resolve.
  Content: class {},
  Tool: class {},
}));

import { AIClient } from '../ai-client';

const messages = [{ role: 'user' as const, content: 'hello' }];

function asAsyncIterable<T>(chunks: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

beforeEach(() => {
  mocks.openaiCreate.mockReset();
  mocks.responsesCreate.mockReset();
  mocks.responsesStream.mockReset();
  mocks.anthropicCreate.mockReset();
  mocks.anthropicStream.mockReset();
  mocks.geminiGenerate.mockReset();
  mocks.geminiGenerateStream.mockReset();
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe('OpenAIAdapter temperature handling', () => {
  function mockCompleteResponse() {
    mocks.openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  function mockStreamResponse() {
    mocks.openaiCreate.mockResolvedValueOnce(
      asAsyncIterable([
        { choices: [{ delta: { content: 'ok' } }] },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]),
    );
  }

  it('complete: passes temperature for gpt-4o-mini', async () => {
    mockCompleteResponse();
    const client = new AIClient('openai', 'sk-test');
    await client.complete('gpt-4o-mini', messages, { temperature: 0.42 });
    const body = mocks.openaiCreate.mock.calls[0][0];
    expect(body).toHaveProperty('temperature', 0.42);
  });

  it('complete: omits temperature for gpt-5.5 (Responses API path)', async () => {
    mocks.responsesCreate.mockResolvedValueOnce({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const client = new AIClient('openai', 'sk-test');
    await client.complete('gpt-5.5', messages, { temperature: 0.42 });
    const body = mocks.responsesCreate.mock.calls[0][0];
    expect(body).not.toHaveProperty('temperature');
  });

  it.each(['gpt-5', 'gpt-5-mini', 'gpt-5.1', 'o1', 'o3-mini', 'o4-mini'])(
    'complete: omits temperature for unsupported model %s',
    async (model) => {
      mockCompleteResponse();
      const client = new AIClient('openai', 'sk-test');
      await client.complete(model, messages, { temperature: 0.7 });
      const body = mocks.openaiCreate.mock.calls[0][0];
      expect(body).not.toHaveProperty('temperature');
    },
  );

  it('streamComplete: passes temperature for gpt-4o-mini', async () => {
    mockStreamResponse();
    const client = new AIClient('openai', 'sk-test');
    await client.streamComplete('gpt-4o-mini', messages, { temperature: 0.31 }, () => {});
    const body = mocks.openaiCreate.mock.calls[0][0];
    expect(body).toHaveProperty('temperature', 0.31);
    expect(body).toHaveProperty('stream', true);
  });

  it('streamComplete: omits temperature for gpt-5.5 (Responses API path)', async () => {
    const stream: any = asAsyncIterable([
      { type: 'response.output_text.delta', delta: 'ok' },
    ]);
    stream.finalResponse = vi.fn().mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    mocks.responsesStream.mockReturnValueOnce(stream);
    const client = new AIClient('openai', 'sk-test');
    await client.streamComplete('gpt-5.5', messages, { temperature: 0.31 }, () => {});
    const body = mocks.responsesStream.mock.calls[0][0];
    expect(body).not.toHaveProperty('temperature');
  });

  it('streamComplete: omits temperature even when caller passes empty options for gpt-5.5', async () => {
    const stream: any = asAsyncIterable([
      { type: 'response.output_text.delta', delta: 'ok' },
    ]);
    stream.finalResponse = vi.fn().mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    mocks.responsesStream.mockReturnValueOnce(stream);
    const client = new AIClient('openai', 'sk-test');
    await client.streamComplete('gpt-5.5', messages, {}, () => {});
    const body = mocks.responsesStream.mock.calls[0][0];
    expect(body).not.toHaveProperty('temperature');
  });

  it('streamComplete: uses 0.3 default for supported model when caller omits temperature', async () => {
    mockStreamResponse();
    const client = new AIClient('openai', 'sk-test');
    await client.streamComplete('gpt-4o-mini', messages, {}, () => {});
    const body = mocks.openaiCreate.mock.calls[0][0];
    expect(body).toHaveProperty('temperature', 0.3);
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe('AnthropicAdapter temperature handling', () => {
  function mockCompleteResponse() {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  function mockStreamResponse() {
    const finalMessage = vi.fn().mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stream: any = asAsyncIterable([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
    ]);
    stream.finalMessage = finalMessage;
    mocks.anthropicStream.mockReturnValueOnce(stream);
  }

  it('complete: passes temperature for claude-sonnet-4-5', async () => {
    mockCompleteResponse();
    const client = new AIClient('anthropic', 'sk-anthropic-test');
    await client.complete('claude-sonnet-4-5', messages, { temperature: 0.42 });
    const body = mocks.anthropicCreate.mock.calls[0][0];
    expect(body).toHaveProperty('temperature', 0.42);
  });

  it.each([
    'claude-haiku-4-5-20251001',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6',
  ])('complete: passes temperature for supported model %s', async (model) => {
    mockCompleteResponse();
    const client = new AIClient('anthropic', 'sk-anthropic-test');
    await client.complete(model, messages, { temperature: 0.5 });
    const body = mocks.anthropicCreate.mock.calls[0][0];
    expect(body).toHaveProperty('temperature', 0.5);
  });

  it.each(['claude-opus-4-7', 'claude-opus-4-7-20260101'])(
    'complete: omits temperature for unsupported model %s',
    async (model) => {
      mockCompleteResponse();
      const client = new AIClient('anthropic', 'sk-anthropic-test');
      await client.complete(model, messages, { temperature: 0.5 });
      const body = mocks.anthropicCreate.mock.calls[0][0];
      expect(body).not.toHaveProperty('temperature');
    },
  );

  it('streamComplete: passes temperature for claude-sonnet-4-5', async () => {
    mockStreamResponse();
    const client = new AIClient('anthropic', 'sk-anthropic-test');
    await client.streamComplete('claude-sonnet-4-5', messages, { temperature: 0.6 }, () => {});
    const body = mocks.anthropicStream.mock.calls[0][0];
    expect(body).toHaveProperty('temperature', 0.6);
  });

  it('streamComplete: omits temperature for claude-opus-4-7', async () => {
    mockStreamResponse();
    const client = new AIClient('anthropic', 'sk-anthropic-test');
    await client.streamComplete('claude-opus-4-7', messages, { temperature: 0.6 }, () => {});
    const body = mocks.anthropicStream.mock.calls[0][0];
    expect(body).not.toHaveProperty('temperature');
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe('GeminiAdapter temperature handling', () => {
  function mockCompleteResponse() {
    mocks.geminiGenerate.mockResolvedValueOnce({
      candidates: [
        {
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  }

  function mockStreamResponse() {
    mocks.geminiGenerateStream.mockResolvedValueOnce(
      asAsyncIterable([
        { text: 'ok' },
        {
          text: '',
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
      ]),
    );
  }

  it.each(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro'])(
    'complete: passes temperature for %s (all Gemini models accept it)',
    async (model) => {
      mockCompleteResponse();
      const client = new AIClient('gemini', 'gemini-test-key');
      await client.complete(model, messages, { temperature: 0.42 });
      const body = mocks.geminiGenerate.mock.calls[0][0];
      expect(body.config).toHaveProperty('temperature', 0.42);
    },
  );

  it('streamComplete: passes temperature for gemini-2.5-pro', async () => {
    mockStreamResponse();
    const client = new AIClient('gemini', 'gemini-test-key');
    await client.streamComplete('gemini-2.5-pro', messages, { temperature: 0.31 }, () => {});
    const body = mocks.geminiGenerateStream.mock.calls[0][0];
    expect(body.config).toHaveProperty('temperature', 0.31);
  });

  it('streamComplete: applies default 0.3 when caller omits temperature', async () => {
    mockStreamResponse();
    const client = new AIClient('gemini', 'gemini-test-key');
    await client.streamComplete('gemini-2.5-pro', messages, {}, () => {});
    const body = mocks.geminiGenerateStream.mock.calls[0][0];
    expect(body.config).toHaveProperty('temperature', 0.3);
  });
});
