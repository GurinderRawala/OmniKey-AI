/**
 * Tests for the temperature-handling change in `runEnhancementModel`.
 *
 * - 'enhance' → pinned cheap model + { temperature: 0.3 }
 * - 'grammar' → pinned cheap model + { temperature: 0.3 }
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
}));

vi.mock('../ai-client', () => ({
  aiClient: { streamComplete: mocks.streamComplete },
  getFixedHelperModel: mocks.getFixedHelperModel,
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

import { runEnhancementModel } from '../featureRoutes';
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
    expect(mocks.getAgentSettings).toHaveBeenCalledTimes(1);
    expect(mocks.selectedAgentModelForProvider).toHaveBeenCalledTimes(1);
  });
});
