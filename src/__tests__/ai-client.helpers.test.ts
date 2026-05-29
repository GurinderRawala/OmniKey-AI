import { describe, it, expect } from 'vitest';
import { modelSupportsTemperature, getDefaultModel } from '../ai-client';

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
    ])('rejects temperature for opus-4-7 variant %s', (model, expected) => {
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
      // Anthropic smart tier is claude-opus-4-7 → no temperature.
      anthropic: false,
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
