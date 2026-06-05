/**
 * Tests for the Nemotron adapter.
 *
 * The Nemotron adapter delegates to the `openai` SDK with a custom `baseURL`
 * (NVIDIA NIM is OpenAI-compatible), so these tests mock the same surface as
 * `ai-client.adapters.test.ts` and verify that:
 *  - the OpenAI client is constructed with the correct `baseURL`,
 *  - chat completions are routed through the Nemotron model id, and
 *  - streaming is wired up end-to-end including usage accounting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  openaiCtor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.openaiCreate } };
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
  mocks.openaiCtor.mockReset();
});

describe('NemotronAdapter', () => {
  it('targets the public NVIDIA NIM endpoint by default', () => {
    new AIClient('nemotron', 'nvapi-test');
    expect(mocks.openaiCtor).toHaveBeenCalledTimes(1);
    const opts = mocks.openaiCtor.mock.calls[0][0];
    expect(opts).toMatchObject({
      apiKey: 'nvapi-test',
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });
  });

  it('honours a custom NEMOTRON_BASE_URL for self-hosted NIM', () => {
    new AIClient('nemotron', 'nvapi-test', {
      nemotronBaseURL: 'http://my-nim:8000/v1',
    });
    const opts = mocks.openaiCtor.mock.calls[0][0];
    expect(opts.baseURL).toBe('http://my-nim:8000/v1');
  });

  it('complete: sends the Nemotron model id and passes temperature', async () => {
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
    expect(result.content).toBe('hi');
    expect(result.usage?.total_tokens).toBe(6);
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
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const body = mocks.openaiCreate.mock.calls[0][0];
    expect(body).toMatchObject({ stream: true });
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
