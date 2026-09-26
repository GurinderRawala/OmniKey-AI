/**
 * Tests for the temperature-handling change in `runEnhancementModel`.
 *
 * - 'enhance' → optional writing-model override, otherwise cheap default + { temperature: 0.3 }
 * - 'grammar' → optional writing-model override, otherwise cheap default + { temperature: 0.3 }
 * - 'task'    → DB-backed selected agent model + {} (no temperature)
 *
 * Mocks `./ai-client` and `./models/subscriptionTaskTemplate` so the test
 * stays a pure unit test and never touches the database or any SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import winston from 'winston';

const mocks = vi.hoisted(() => ({
  streamComplete: vi.fn(),
  getFixedHelperModel: vi.fn(),
  findOne: vi.fn(),
  getAgentSettings: vi.fn(),
  selectedAgentModelForProvider: vi.fn(),
  modelSupportsTemperature: vi.fn(),
}));

vi.mock('../ai-client', () => ({
  aiClient: { streamComplete: mocks.streamComplete },
  getFixedHelperModel: mocks.getFixedHelperModel,
  modelSupportsTemperature: mocks.modelSupportsTemperature,
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    config: { ...actual.config, aiProvider: 'openai' },
  };
});

vi.mock('../models/subscriptionTaskTemplate', () => ({
  SubscriptionTaskTemplate: { findOne: mocks.findOne },
}));

vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: mocks.getAgentSettings,
  selectedAgentModelForProvider: mocks.selectedAgentModelForProvider,
}));

import {
  createOmniKeyDirectiveMessages,
  runEnhancementModel,
  runOmniKeyDirectiveModel,
} from '../featureRoutes';
import type { Subscription } from '../models/subscription';

function makeLogger() {
  return winston.createLogger({
    silent: true,
    transports: [new winston.transports.Console({ silent: true })],
  });
}

const fakeSubscription = { id: 'sub_test' } as unknown as Subscription;

beforeEach(() => {
  mocks.streamComplete.mockReset();
  mocks.streamComplete.mockResolvedValue({ usage: undefined, model: 'mock-model' });

  mocks.getFixedHelperModel.mockReset();
  mocks.getFixedHelperModel.mockReturnValue('fixed-openai-helper-model');
  mocks.modelSupportsTemperature.mockReset();
  mocks.modelSupportsTemperature.mockReturnValue(true);

  mocks.getAgentSettings.mockReset();
  mocks.getAgentSettings.mockResolvedValue({
    id: 'default',
    terminalAccess: 'full',
    webSearchEnabled: true,
    usageRecordingEnabled: true,
    browserAccessEnabled: false,
    openaiModel: 'stored-openai-agent-model',
    anthropicModel: 'stored-anthropic-agent-model',
    geminiModel: 'stored-gemini-agent-model',
    nemotronModel: 'stored-open-model-agent-model',
    grammarEnhancementModel: null,
    grammarEnhancementProvider: null,
  });

  mocks.selectedAgentModelForProvider.mockReset();
  mocks.selectedAgentModelForProvider.mockReturnValue('stored-openai-agent-model');

  mocks.findOne.mockReset();
  // Default task template — plain text passes through `decompressString`
  // so `getPromptForCommand('task', ...)` returns a non-empty prompt and the
  // streamComplete path is reached.
  mocks.findOne.mockResolvedValue({ instructions: 'You are a helpful task assistant.' });
});

describe('runEnhancementModel — temperature per command', () => {
  it("passes temperature: 0.3 for cmd='enhance'", async () => {
    const result = await runEnhancementModel(
      makeLogger(),
      'hello world',
      'enhance',
      fakeSubscription,
    );
    expect(result).not.toBeNull();
    expect(mocks.streamComplete).toHaveBeenCalledTimes(1);
    const [, , options] = mocks.streamComplete.mock.calls[0];
    expect(options).toEqual({ temperature: 0.3 });
  });

  it("passes temperature: 0.3 for cmd='grammar'", async () => {
    const result = await runEnhancementModel(
      makeLogger(),
      'helo wrld',
      'grammar',
      fakeSubscription,
    );
    expect(result).not.toBeNull();
    expect(mocks.streamComplete).toHaveBeenCalledTimes(1);
    const [, , options] = mocks.streamComplete.mock.calls[0];
    expect(options).toEqual({ temperature: 0.3 });
  });

  it("omits temperature for cmd='task' (custom-task)", async () => {
    const result = await runEnhancementModel(
      makeLogger(),
      'do the thing',
      'task',
      fakeSubscription,
    );
    expect(result).not.toBeNull();
    expect(mocks.streamComplete).toHaveBeenCalledTimes(1);
    const [, , options] = mocks.streamComplete.mock.calls[0];
    expect(options).toEqual({});
    expect(options).not.toHaveProperty('temperature');
  });

  it("selects the stored agent model for cmd='task' and pinned cheap model for enhance/grammar", async () => {
    await runEnhancementModel(makeLogger(), 'a', 'task', fakeSubscription);
    await runEnhancementModel(makeLogger(), 'b', 'enhance', fakeSubscription);
    await runEnhancementModel(makeLogger(), 'c', 'grammar', fakeSubscription);

    const modelsCalled = mocks.streamComplete.mock.calls.map(([model]) => model);
    expect(modelsCalled).toEqual([
      'stored-openai-agent-model',
      'fixed-openai-helper-model',
      'fixed-openai-helper-model',
    ]);
    expect(mocks.getFixedHelperModel).toHaveBeenCalledTimes(2);
    expect(mocks.getFixedHelperModel).toHaveBeenCalledWith('openai');
    expect(mocks.getAgentSettings).toHaveBeenCalledTimes(3);
    expect(mocks.selectedAgentModelForProvider).toHaveBeenCalledTimes(1);
  });

  it('uses the optional grammar and enhancement model override for both shortcuts', async () => {
    mocks.getAgentSettings.mockResolvedValue({
      id: 'default',
      grammarEnhancementModel: 'custom-writing-model',
      grammarEnhancementProvider: 'openai',
    });

    await runEnhancementModel(makeLogger(), 'a', 'enhance', fakeSubscription);
    await runEnhancementModel(makeLogger(), 'b', 'grammar', fakeSubscription);

    expect(mocks.streamComplete.mock.calls.map(([model]) => model)).toEqual([
      'custom-writing-model',
      'custom-writing-model',
    ]);
    expect(mocks.getFixedHelperModel).not.toHaveBeenCalled();
  });

  it('omits temperature when the custom writing model does not support it', async () => {
    mocks.getAgentSettings.mockResolvedValue({
      id: 'default',
      grammarEnhancementModel: 'reasoning-model',
      grammarEnhancementProvider: 'openai',
    });
    mocks.modelSupportsTemperature.mockReturnValue(false);

    await runEnhancementModel(makeLogger(), 'a', 'enhance', fakeSubscription);

    expect(mocks.streamComplete.mock.calls[0][2]).toEqual({});
  });

  it('falls back to the provider default when the override belongs to another provider', async () => {
    mocks.getAgentSettings.mockResolvedValue({
      id: 'default',
      grammarEnhancementModel: 'claude-writing-model',
      grammarEnhancementProvider: 'anthropic',
    });

    await runEnhancementModel(makeLogger(), 'a', 'grammar', fakeSubscription);

    expect(mocks.streamComplete.mock.calls[0][0]).toBe('fixed-openai-helper-model');
    expect(mocks.getFixedHelperModel).toHaveBeenCalledWith('openai');
  });
});

describe('@omnikeyai directive model', () => {
  it('uses only directive instructions and context instead of the shortcut prompt', () => {
    const messages = createOmniKeyDirectiveMessages({
      instructions: 'Summarize this as three bullets.',
      context: 'A long source document.',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(
      'Follow the task instructions written in the `<omnikeyai_directive>` tag.',
    );
    expect(messages[0].content).not.toContain('grammar shortcut prompt');
    expect(messages[1].content).toContain(
      '<omnikeyai_directive>\nSummarize this as three bullets.\n</omnikeyai_directive>',
    );
    expect(messages[1].content).toContain('<context>\nA long source document.\n</context>');
  });

  it('uses the smart model with no temperature and skips shortcut prompt loading', async () => {
    const result = await runOmniKeyDirectiveModel(
      makeLogger(),
      { instructions: 'explain this', context: '' },
      fakeSubscription,
    );

    expect(result).not.toBeNull();
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.getFixedHelperModel).not.toHaveBeenCalled();
    expect(mocks.selectedAgentModelForProvider).toHaveBeenCalledTimes(1);
    const [model, messages, options] = mocks.streamComplete.mock.calls[0];
    expect(model).toBe('stored-openai-agent-model');
    expect(options).toEqual({});
    expect(messages[0].content).not.toContain('prompt editor');
  });
});
