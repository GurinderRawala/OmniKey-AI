/**
 * Tests for the OpenAI-compatible open-model adapter.
 *
 * The legacy provider id is still `nemotron`, but the adapter delegates to the
 * `openai` SDK with a custom `baseURL`, so these tests mock the same surface as
 * `ai-client.adapters.test.ts` and verify that:
 *  - the OpenAI client is constructed with the correct `baseURL`,
 *  - chat completions remain the default broad-compatibility path,
 *  - Responses API can be enabled for compatible gateways, and
 *  - streaming is wired up end-to-end including usage accounting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  responsesCreate: vi.fn(),
  responsesStream: vi.fn(),
  openaiCtor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.openaiCreate } };
    responses = { create: mocks.responsesCreate, stream: mocks.responsesStream };
    images = { generate: vi.fn() };
    constructor(opts: unknown) {
      mocks.openaiCtor(opts);
    }
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn(), stream: vi.fn() };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      generateImages: vi.fn(),
    };
    constructor(_opts: unknown) {}
  },
  Content: class {},
  Tool: class {},
}));

import { AIClient, getDefaultModel, providerSupportsImageGeneration } from '../ai-client';

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
  mocks.openaiCtor.mockReset();
});

describe('OpenAI-compatible open-model adapter', () => {
  it('targets the public NVIDIA NIM endpoint by default', () => {
    new AIClient('nemotron', 'nvapi-test');
    expect(mocks.openaiCtor).toHaveBeenCalledTimes(1);
    const opts = mocks.openaiCtor.mock.calls[0][0];
    expect(opts).toMatchObject({
      apiKey: 'nvapi-test',
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });
  });

  it('honours a custom base URL for a self-hosted OpenAI-compatible gateway', () => {
    new AIClient('nemotron', 'nvapi-test', {
      nemotronBaseURL: 'http://my-nim:8000/v1',
    });
    const opts = mocks.openaiCtor.mock.calls[0][0];
    expect(opts.baseURL).toBe('http://my-nim:8000/v1');
  });

  it('complete: uses Chat Completions by default with the chosen model id', async () => {
    mocks.openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi', tool_calls: undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });

    const client = new AIClient('nemotron', 'nvapi-test');
    const result = await client.complete('nvidia/nemotron-3-super-120b-a12b', messages, {
      temperature: 0.42,
    });

    const body = mocks.openaiCreate.mock.calls[0][0];
    expect(body).toMatchObject({
      model: 'nvidia/nemotron-3-super-120b-a12b',
      temperature: 0.42,
    });
    expect(mocks.responsesCreate).not.toHaveBeenCalled();
    expect(result.content).toBe('hi');
    expect(result.usage?.total_tokens).toBe(6);
  });

  it('complete: uses Responses API when enabled for the provider', async () => {
    mocks.responsesCreate.mockResolvedValueOnce({
      model: 'meta/llama-4-coder',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    });

    const client = new AIClient('nemotron', 'local-key', {
      nemotronBaseURL: 'http://localhost:8000/v1',
      nemotronResponsesApiEnabled: true,
    });
    const result = await client.complete('meta/llama-4-coder', messages, { maxTokens: 200 });

    const body = mocks.responsesCreate.mock.calls[0][0];
    expect(body).toMatchObject({
      model: 'meta/llama-4-coder',
      max_output_tokens: 200,
    });
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
    expect(result.content).toBe('done');
    expect(result.usage?.total_tokens).toBe(11);
  });

  it('streamComplete: forwards deltas and captures usage', async () => {
    mocks.openaiCreate.mockResolvedValueOnce(
      asAsyncIterable([
        { choices: [{ delta: { content: 'he' } }] },
        { choices: [{ delta: { content: 'llo' } }] },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      ]),
    );

    const client = new AIClient('nemotron', 'nvapi-test');
    const received: string[] = [];
    const { usage } = await client.streamComplete(
      'nvidia/nemotron-3-nano-30b-a3b',
      messages,
      {},
      (d) => received.push(d),
    );

    expect(received.join('')).toBe('hello');
    expect(usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      cached_tokens: 0,
      cache_write_tokens: 0,
    });
    const body = mocks.openaiCreate.mock.calls[0][0];
    expect(body).toMatchObject({ stream: true });
    expect(mocks.responsesStream).not.toHaveBeenCalled();
  });

  it('streamComplete: streams Responses API deltas when enabled', async () => {
    const stream: any = asAsyncIterable([
      { type: 'response.output_text.delta', delta: 'op' },
      { type: 'response.output_text.delta', delta: 'en' },
    ]);
    stream.finalResponse = vi.fn().mockResolvedValue({
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
    mocks.responsesStream.mockReturnValueOnce(stream);

    const client = new AIClient('nemotron', 'local-key', { nemotronResponsesApiEnabled: true });
    const received: string[] = [];
    const { usage } = await client.streamComplete(
      'qwen/qwen3-coder',
      messages,
      { maxTokens: 42 },
      (d) => received.push(d),
    );

    expect(received.join('')).toBe('open');
    expect(usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      cached_tokens: 0,
      cache_write_tokens: 0,
    });
    const body = mocks.responsesStream.mock.calls[0][0];
    expect(body).toMatchObject({
      model: 'qwen/qwen3-coder',
      max_output_tokens: 42,
    });
  });

  it('exposes fast and smart defaults via getDefaultModel', () => {
    expect(getDefaultModel('nemotron', 'fast')).toBe('nvidia/nemotron-3-nano-30b-a3b');
    expect(getDefaultModel('nemotron', 'smart')).toBe('nvidia/nemotron-3-ultra-550b-a55b');
  });

  it('reports image generation as unsupported', () => {
    const client = new AIClient('nemotron', 'nvapi-test');
    expect(client.supportsImageGeneration()).toBe(false);
    expect(providerSupportsImageGeneration('nemotron')).toBe(false);
  });

  it('generateImage rejects with an unsupported-provider error', async () => {
    const client = new AIClient('nemotron', 'nvapi-test');
    await expect(client.generateImage({ prompt: 'a test image' })).rejects.toThrow(
      /not supported for provider "nemotron"/,
    );
  });
});
