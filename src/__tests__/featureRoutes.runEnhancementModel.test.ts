/**
 * Tests for the temperature-handling change in `runEnhancementModel`.
 *
 * - 'enhance' → { temperature: 0.3 }
 * - 'grammar' → { temperature: 0.3 }
 * - 'task'    → {}   (no temperature; smart-tier model decides for itself)
 *
 * Mocks `./ai-client` and `./models/subscriptionTaskTemplate` so the test
 * stays a pure unit test and never touches the database or any SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import winston from 'winston';

const mocks = vi.hoisted(() => ({
  streamComplete: vi.fn(),
  getDefaultModel: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock('../ai-client', () => ({
  aiClient: { streamComplete: mocks.streamComplete },
  getDefaultModel: mocks.getDefaultModel,
}));

vi.mock('../models/subscriptionTaskTemplate', () => ({
  SubscriptionTaskTemplate: { findOne: mocks.findOne },
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

  mocks.getDefaultModel.mockReset();
  mocks.getDefaultModel.mockImplementation((_provider: string, tier: 'fast' | 'smart') =>
    tier === 'smart' ? 'smart-model-mock' : 'fast-model-mock',
  );

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

  it("selects the smart-tier model for cmd='task' and fast-tier for enhance/grammar", async () => {
    await runEnhancementModel(makeLogger(), 'a', 'task', fakeSubscription);
    await runEnhancementModel(makeLogger(), 'b', 'enhance', fakeSubscription);
    await runEnhancementModel(makeLogger(), 'c', 'grammar', fakeSubscription);

    const modelsCalled = mocks.streamComplete.mock.calls.map(([model]) => model);
    expect(modelsCalled).toEqual(['smart-model-mock', 'fast-model-mock', 'fast-model-mock']);
  });
});
