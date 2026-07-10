/**
 * Tests for `getDefaultTaskTemplateSnapshot` — the helper used by the agent
 * server to freeze a session's task-instruction choice at creation time.
 *
 * The snapshot must:
 *   - Return { id, heading, instructions } for the subscription's current
 *     default template, so the caller can persist those fields on the
 *     AgentSession row.
 *   - Return `null` when the subscription has no default template configured.
 *   - Swallow DB errors (returning `null`) so a transient failure never
 *     blocks a new session from being created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import winston from 'winston';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
}));

vi.mock('../models/subscriptionTaskTemplate', () => ({
  SubscriptionTaskTemplate: { findOne: mocks.findOne },
}));

import { getDefaultTaskTemplateSnapshot } from '../featureRoutes';
import type { Subscription } from '../models/subscription';

function makeLogger() {
  return winston.createLogger({
    silent: true,
    transports: [new winston.transports.Console({ silent: true })],
  });
}

const fakeSubscription = { id: 'sub_test' } as unknown as Subscription;

beforeEach(() => {
  mocks.findOne.mockReset();
});

describe('getDefaultTaskTemplateSnapshot', () => {
  it('returns { id, heading, instructions } for the current default template', async () => {
    mocks.findOne.mockResolvedValue({
      id: 'tpl_abc',
      heading: 'Coding assistant',
      instructions: 'You are a helpful coding assistant.',
    });

    const snapshot = await getDefaultTaskTemplateSnapshot(makeLogger(), fakeSubscription);

    expect(snapshot).toEqual({
      id: 'tpl_abc',
      heading: 'Coding assistant',
      instructions: 'You are a helpful coding assistant.',
    });
  });

  it('returns null when no default template exists', async () => {
    mocks.findOne.mockResolvedValue(null);

    const snapshot = await getDefaultTaskTemplateSnapshot(makeLogger(), fakeSubscription);

    expect(snapshot).toBeNull();
  });

  it('returns null when the DB throws (never blocks session creation)', async () => {
    mocks.findOne.mockRejectedValue(new Error('DB down'));

    const snapshot = await getDefaultTaskTemplateSnapshot(makeLogger(), fakeSubscription);

    expect(snapshot).toBeNull();
  });

  it('propagates a nullable heading as null (never as undefined)', async () => {
    mocks.findOne.mockResolvedValue({
      id: 'tpl_no_heading',
      // heading intentionally omitted so `?? null` runs
      instructions: 'Plaintext instruction body.',
    });

    const snapshot = await getDefaultTaskTemplateSnapshot(makeLogger(), fakeSubscription);

    expect(snapshot).toEqual({
      id: 'tpl_no_heading',
      heading: null,
      instructions: 'Plaintext instruction body.',
    });
  });
});
