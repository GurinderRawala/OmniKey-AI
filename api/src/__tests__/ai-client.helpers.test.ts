import { describe, it, expect } from 'vitest';
import {
  modelSupportsTemperature,
  getDefaultModel,
  getContextWindowSize,
  getMaxHistoryLength,
  getMaxMessageContentLength,
  estimateHistoryTokens,
  getInputTokenBudget,
  modelUsesOpenAIResponsesApi,
} from '../ai-client';
import type { AIMessage } from '../ai-client';

describe('modelSupportsTemperature', () => {
  describe('OpenAI', () => {
    it.each([
      ['gpt-4o-mini', true],
      ['gpt-4o', true],
      ['gpt-4-turbo', true],
      ['gpt-3.5-turbo', true],
    ])('allows temperature for %s', (model, expected) => {
      expect(modelSupportsTemperature(model)).toBe(expected);
    });

    it.each([
      ['gpt-5', false],
      ['gpt-5-mini', false],
      ['gpt-5.1', false],
      ['gpt-5.5', false],
      ['gpt-5.6', false],
      ['GPT-5.5', false], // case-insensitive
    ])('rejects temperature for GPT-5 family member %s', (model, expected) => {
      expect(modelSupportsTemperature(model)).toBe(expected);
    });

    it.each([
      ['o1', false],
      ['o1-preview', false],
      ['o3', false],
      ['o3-mini', false],
      ['o4-mini', false],
    ])('rejects temperature for reasoning model %s', (model, expected) => {
      expect(modelSupportsTemperature(model)).toBe(expected);
    });
  });

  describe('Gemini', () => {
    it.each([
      ['gemini-2.5-flash', true],
      ['gemini-2.5-pro', true],
      ['gemini-3-pro', true],
      ['gemini-3.5-flash', true],
    ])('allows temperature for %s', (model, expected) => {
      expect(modelSupportsTemperature(model)).toBe(expected);
    });
  });

  describe('Anthropic', () => {
    it.each([
      ['claude-haiku-4-5', true],
      ['claude-haiku-4-5-20251001', true],
      ['claude-sonnet-4-5', true],
      ['claude-sonnet-4-5-20250929', true],
      ['claude-opus-4-5', true],
      ['claude-opus-4-5-20251101', true],
      ['claude-opus-4-6', true],
    ])('allows temperature for %s', (model, expected) => {
      expect(modelSupportsTemperature(model)).toBe(expected);
    });

    it.each([
      ['claude-opus-4-7', false],
      ['claude-opus-4-7-20260101', false],
      ['CLAUDE-OPUS-4-7', false], // case-insensitive
      ['claude-opus-5', false],
      ['claude-fable-5', false],
      ['claude-sonnet-5', false],
      ['claude-sonnet-4-6', false],
    ])('rejects temperature for adaptive-thinking Claude variant %s', (model, expected) => {
      expect(modelSupportsTemperature(model)).toBe(expected);
    });
  });
});

describe('getDefaultModel', () => {
  it('returns the configured fast and smart tiers for each provider', () => {
    // Don't pin exact model strings — they will be upgraded over time. Just
    // assert that each provider returns a non-empty string for both tiers
    // and that fast/smart differ (smart is meant to be a bigger model).
    for (const provider of ['openai', 'gemini', 'anthropic'] as const) {
      const fast = getDefaultModel(provider, 'fast');
      const smart = getDefaultModel(provider, 'smart');
      expect(fast).toBeTruthy();
      expect(smart).toBeTruthy();
      expect(fast).not.toEqual(smart);
    }
  });

  it('returns smart-tier models that are correctly classified by modelSupportsTemperature', () => {
    // Regression guard: whenever a smart model is upgraded, the helper must
    // continue to return the correct policy for it. This test is the single
    // place that ties the two together so an accidental mismatch breaks the
    // suite immediately.
    const expectations: Record<'openai' | 'gemini' | 'anthropic', boolean | null> = {
      // OpenAI smart tier is in the GPT-5 family → no temperature.
      openai: false,
      // Gemini smart tier accepts temperature.
      gemini: true,
      // Anthropic smart tier is currently claude-opus-4-5.
      anthropic: true,
    };

    for (const provider of Object.keys(expectations) as Array<keyof typeof expectations>) {
      const expected = expectations[provider];
      if (expected === null) continue;
      const smartModel = getDefaultModel(provider, 'smart');
      expect(
        modelSupportsTemperature(smartModel),
        `${provider} smart model "${smartModel}" should report temperature-support=${expected}`,
      ).toBe(expected);
    }
  });
});

describe('getContextWindowSize', () => {
  it('returns realistic per-model windows for the configured smart tiers', () => {
    // The window is resolved from each provider's active smart-tier model.
    expect(getContextWindowSize('openai', 'gpt-5.5')).toBe(1_000_000);
    expect(getContextWindowSize('openai', 'gpt-5.6')).toBe(1_000_000);
    expect(getContextWindowSize('anthropic', 'claude-opus-4-5')).toBe(1_000_000);
    expect(getContextWindowSize('anthropic', 'claude-opus-4-7')).toBe(1_000_000);
    expect(getContextWindowSize('anthropic', 'claude-opus-5')).toBe(1_000_000);
    expect(getContextWindowSize('anthropic', 'claude-fable-5')).toBe(1_000_000);
    expect(getContextWindowSize('anthropic', 'claude-sonnet-5')).toBe(1_000_000);
    expect(getContextWindowSize('gemini', 'gemini-2.5-pro')).toBe(1_048_576);
    // Nemotron's stock NIM endpoint serves 256K natively, NOT 1M — this is the
    // value that keeps the char budget from over-promising and overflowing.
    expect(getContextWindowSize('nemotron', 'nvidia/nemotron-3-ultra-550b-a55b')).toBe(262_144);
  });

  it('maps common alternative models to their published windows', () => {
    expect(getContextWindowSize('openai', 'gpt-5')).toBe(400_000); // base GPT-5
    expect(getContextWindowSize('openai', 'gpt-4o')).toBe(128_000);
    expect(getContextWindowSize('openai', 'gpt-4o-mini')).toBe(128_000);
    expect(getContextWindowSize('openai', 'gpt-4.1')).toBe(1_000_000);
    expect(getContextWindowSize('openai', 'o3-mini')).toBe(200_000);
    // Non-Opus-4.7 Claude models are 200K unless the 1M beta is opted into.
    expect(getContextWindowSize('anthropic', 'claude-haiku-4-5')).toBe(200_000);
    expect(getContextWindowSize('anthropic', 'claude-sonnet-4-5')).toBe(200_000);
  });

  it('resolves the provider default smart model when none is passed', () => {
    for (const provider of ['openai', 'gemini', 'anthropic', 'nemotron'] as const) {
      expect(getContextWindowSize(provider)).toBeGreaterThan(0);
    }
  });

  it('falls back to a conservative window for unknown models', () => {
    expect(getContextWindowSize('openai', 'some-future-model')).toBe(128_000);
    expect(getContextWindowSize('anthropic', 'some-future-claude')).toBe(200_000);
  });
});

describe('modelUsesOpenAIResponsesApi', () => {
  it('routes GPT 5.5 and GPT 5.6 through Responses API', () => {
    expect(modelUsesOpenAIResponsesApi('gpt-5.5')).toBe(true);
    expect(modelUsesOpenAIResponsesApi('gpt-5.6')).toBe(true);
    expect(modelUsesOpenAIResponsesApi('gpt-5.1')).toBe(false);
  });
});

describe('getMaxHistoryLength / getMaxMessageContentLength', () => {
  it('derives the history char budget from the real window (input tokens x 2)', () => {
    // 262,144 window − 40,000 output reserve = 222,144 input tokens × 2 chars.
    expect(getMaxHistoryLength('nemotron', 'nvidia/nemotron-3-ultra-550b-a55b')).toBe(
      (262_144 - 40_000) * 2,
    );
    // A smaller model yields a proportionally smaller budget.
    expect(getMaxHistoryLength('openai', 'gpt-4o')).toBe((128_000 - 40_000) * 2);
  });

  it('caps a single Anthropic message at the hard API string limit', () => {
    expect(getMaxMessageContentLength('anthropic')).toBe(10_000_000);
  });

  it('bounds a single non-Anthropic message by the history budget', () => {
    expect(getMaxMessageContentLength('openai', 'gpt-4o')).toBe(getMaxHistoryLength('openai', 'gpt-4o'));
  });
});

describe('estimateHistoryTokens', () => {
  it('estimates from content length (~3.5 chars/token)', () => {
    const history: AIMessage[] = [{ role: 'user', content: 'x'.repeat(3500) }];
    expect(estimateHistoryTokens(history)).toBe(1000);
  });

  it('counts tool-call arguments, which the char budget ignores', () => {
    const withTool: AIMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'shell_script', arguments: { script: 'y'.repeat(700) } }],
      },
    ];
    // The serialized arguments dominate the estimate — a history that looks
    // empty by content alone still consumes real context.
    expect(estimateHistoryTokens(withTool)).toBeGreaterThan(200);
  });

  it('grows when an oversized message is appended (the stale-UI scenario)', () => {
    const before: AIMessage[] = [{ role: 'user', content: 'short' }];
    const after: AIMessage[] = [...before, { role: 'user', content: 'z'.repeat(500_000) }];
    expect(estimateHistoryTokens(after)).toBeGreaterThan(estimateHistoryTokens(before) + 100_000);
  });
});

describe('getInputTokenBudget', () => {
  it('is the context window minus the output reserve', () => {
    // Nemotron: 262,144 window − 40,000 reserve.
    expect(getInputTokenBudget('nemotron', 'nvidia/nemotron-3-ultra-550b-a55b')).toBe(
      262_144 - 40_000,
    );
    expect(getInputTokenBudget('anthropic', 'claude-opus-4-7')).toBe(1_000_000 - 40_000);
  });
});
