/**
 * Tests for the token-only `GET /api/usage` response.
 *
 * Cost estimation and the price-per-1M-token override were removed from this
 * endpoint, so these tests lock in the remaining contract:
 *   - the token metrics the macOS Usage tab renders
 *   - daily, model, and recent-session token aggregates
 *   - range parsing (`7d` / `month` / `all`) and the day count used as the
 *     daily-average divisor
 *   - the provider filter being pushed into the query instead of filtered in JS
 *   - no cost/pricing keys leaking back into the payload
 *
 * `authMiddleware`, `agentSettingsStore`, and the Sequelize model are mocked so
 * this stays a unit test that never touches the database.
 */

import express from 'express';
import request from 'supertest';
import { Op } from 'sequelize';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import winston from 'winston';

const mocks = vi.hoisted(() => ({
  usageFindAll: vi.fn(),
  sessionFindAll: vi.fn(),
  getAgentSettings: vi.fn(),
}));

vi.mock('../authMiddleware', () => ({
  authMiddleware: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    res.locals.subscription = { id: 'sub_test' };
    res.locals.logger = winston.createLogger({
      silent: true,
      transports: [new winston.transports.Console({ silent: true })],
    });
    next();
  },
}));

vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: mocks.getAgentSettings,
}));

vi.mock('../models/subscriptionUsage', () => ({
  SubscriptionUsage: { findAll: mocks.usageFindAll },
}));

vi.mock('../models/agentSession', () => ({
  AgentSession: { findAll: mocks.sessionFindAll },
}));

import { createUsageRouter } from '../usageRoutes';

function makeApp() {
  const app = express();
  app.use('/api/usage', createUsageRouter());
  return app;
}

function usageRow(
  promptTokens: number,
  completionTokens: number,
  createdAt: string,
  overrides: Partial<{
    model: string;
    provider: string;
    sessionId: string;
  }> = {},
): Record<string, unknown> {
  return {
    model: overrides.model ?? 'gpt-5.5',
    provider: overrides.provider ?? 'openai',
    sessionId: overrides.sessionId ?? null,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    createdAt: new Date(createdAt),
  };
}

beforeEach(() => {
  mocks.usageFindAll.mockReset();
  mocks.usageFindAll.mockResolvedValue([]);
  mocks.sessionFindAll.mockReset();
  mocks.sessionFindAll.mockResolvedValue([]);
  mocks.getAgentSettings.mockReset();
  mocks.getAgentSettings.mockResolvedValue({ usageRecordingEnabled: true });
});

describe('GET /api/usage — token metrics', () => {
  it('returns total, input, output tokens and the daily average', async () => {
    mocks.usageFindAll.mockResolvedValue([
      usageRow(1_000, 500, '2024-05-01T10:00:00Z'),
      usageRow(2_000, 1_500, '2024-05-02T10:00:00Z'),
    ]);

    const res = await request(makeApp()).get('/api/usage?range=7d');

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      promptTokens: 3_000,
      completionTokens: 2_000,
      totalTokens: 5_000,
      requests: 2,
    });
    expect(res.body.range.days).toBe(7);
    expect(res.body.estimates.averageDailyTokens).toBeCloseTo(5_000 / 7);
  });

  it('returns daily, model, and recent session token aggregates', async () => {
    mocks.usageFindAll.mockResolvedValue([
      usageRow(1_000, 500, '2024-05-01T10:00:00Z', {
        model: 'gpt-5.5',
        provider: 'openai',
        sessionId: 'sess_old',
      }),
      usageRow(2_000, 1_500, '2024-05-02T10:00:00Z', {
        model: 'claude-opus-4-5',
        provider: 'anthropic',
        sessionId: 'sess_recent',
      }),
      usageRow(250, 250, '2024-05-02T12:00:00Z', {
        model: 'gpt-5.5',
        provider: 'openai',
        sessionId: 'sess_recent',
      }),
    ]);
    mocks.sessionFindAll.mockResolvedValue([
      {
        id: 'sess_recent',
        title: 'Recent work',
        turns: 3,
        lastActiveAt: new Date('2024-05-03T08:00:00Z'),
      },
      {
        id: 'sess_old',
        title: 'Older work',
        turns: 1,
        lastActiveAt: new Date('2024-05-01T08:00:00Z'),
      },
    ]);

    const res = await request(makeApp()).get('/api/usage?range=7d');

    expect(res.status).toBe(200);
    expect(res.body.daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: '2024-05-01',
          promptTokens: 1_000,
          completionTokens: 500,
          totalTokens: 1_500,
          requests: 1,
        }),
        expect.objectContaining({
          key: '2024-05-02',
          promptTokens: 2_250,
          completionTokens: 1_750,
          totalTokens: 4_000,
          requests: 2,
        }),
      ]),
    );
    expect(res.body.byModel).toEqual([
      expect.objectContaining({ key: 'claude-opus-4-5', totalTokens: 3_500, requests: 1 }),
      expect.objectContaining({ key: 'gpt-5.5', totalTokens: 2_000, requests: 2 }),
    ]);
    expect(res.body.recentSessions).toEqual([
      expect.objectContaining({ id: 'sess_recent', totalTokens: 4_000, turns: 3 }),
      expect.objectContaining({ id: 'sess_old', totalTokens: 1_500, turns: 1 }),
    ]);
  });

  it('buckets daily usage with the requested local time zone', async () => {
    mocks.usageFindAll.mockResolvedValue([usageRow(900, 100, '2026-07-29T00:30:00Z')]);

    const res = await request(makeApp()).get(
      '/api/usage?range=7d&to=2026-07-29T00:45:00Z&timeZone=America/Toronto',
    );

    expect(res.status).toBe(200);
    expect(res.body.range.timeZone).toBe('America/Toronto');
    expect(res.body.daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: '2026-07-28',
          promptTokens: 900,
          completionTokens: 100,
          totalTokens: 1_000,
          requests: 1,
        }),
      ]),
    );
    expect(
      res.body.daily.some(
        (bucket: { key: string; totalTokens: number }) =>
          bucket.key === '2026-07-29' && bucket.totalTokens > 0,
      ),
    ).toBe(false);
  });

  it('uses local month boundaries for range=month', async () => {
    const res = await request(makeApp()).get(
      '/api/usage?range=month&to=2026-07-29T00:30:00Z&timeZone=America/Toronto',
    );

    const where = mocks.usageFindAll.mock.calls[0][0].where as Record<string, any>;
    const createdAt = where.createdAt as Record<symbol, Date>;
    expect(createdAt[Op.gte].toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(createdAt[Op.lt].toISOString()).toBe('2026-07-29T00:30:00.000Z');
    expect(res.body.range.days).toBe(28);
    expect(res.body.range.timeZone).toBe('America/Toronto');
  });

  it('reports zeroed totals and no NaN average when there is no usage', async () => {
    const res = await request(makeApp()).get('/api/usage?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0,
    });
    expect(res.body.estimates.averageDailyTokens).toBe(0);
    expect(Number.isFinite(res.body.estimates.averageDailyTokens)).toBe(true);
  });

  it('omits all cost and pricing fields from the payload', async () => {
    mocks.usageFindAll.mockResolvedValue([usageRow(100, 100, '2024-05-01T10:00:00Z')]);

    const res = await request(makeApp()).get('/api/usage?range=7d');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('cost');
    expect(serialized).not.toContain('Usd');
    expect(res.body.totals).not.toHaveProperty('costUsd');
    expect(res.body).not.toHaveProperty('pricing');
    expect(res.body.estimates).toEqual({
      averageDailyTokens: expect.any(Number),
    });
  });

  it('ignores a pricePerMillionTokensUsd query parameter', async () => {
    mocks.usageFindAll.mockResolvedValue([usageRow(1_000_000, 0, '2024-05-01T10:00:00Z')]);

    const res = await request(makeApp()).get('/api/usage?range=7d&pricePerMillionTokensUsd=50');

    expect(res.status).toBe(200);
    expect(res.body.totals.totalTokens).toBe(1_000_000);
    expect(res.body.totals).not.toHaveProperty('costUsd');
    expect(res.body.estimates).not.toHaveProperty('estimatedCostUsd');
    expect(res.body).not.toHaveProperty('pricing');
  });

  it('pushes the provider filter into the database query', async () => {
    await request(makeApp()).get('/api/usage?range=7d&provider=anthropic');

    expect(mocks.usageFindAll).toHaveBeenCalledTimes(1);
    const where = mocks.usageFindAll.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.provider).toBe('anthropic');
    expect(where.subscriptionId).toBe('sub_test');
  });

  it('does not constrain provider when "all" is requested', async () => {
    const res = await request(makeApp()).get('/api/usage?range=7d&provider=all');

    const where = mocks.usageFindAll.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty('provider');
    expect(res.body.provider).toEqual({ provider: 'all', providerLabel: 'All Providers' });
  });

  it('derives the day count from distinct active days for range=all', async () => {
    mocks.usageFindAll.mockResolvedValue([
      usageRow(500, 500, '2024-01-01T10:00:00Z'),
      usageRow(500, 500, '2024-01-01T18:00:00Z'),
      usageRow(500, 500, '2024-03-15T10:00:00Z'),
    ]);

    const res = await request(makeApp()).get('/api/usage?range=all');

    expect(res.body.range.label).toBe('All time');
    expect(res.body.range.from).toBeNull();
    // Two distinct days of activity, not the calendar span between them.
    expect(res.body.range.days).toBe(2);
    expect(res.body.estimates.averageDailyTokens).toBeCloseTo(3_000 / 2);
  });

  it('falls back to a 1-day divisor for range=all with no rows', async () => {
    const res = await request(makeApp()).get('/api/usage?range=all');

    expect(res.body.range.days).toBe(1);
    expect(res.body.estimates.averageDailyTokens).toBe(0);
  });

  it('surfaces the recording flag from agent settings', async () => {
    mocks.getAgentSettings.mockResolvedValue({ usageRecordingEnabled: false });

    const res = await request(makeApp()).get('/api/usage?range=7d');

    expect(res.body.recordingEnabled).toBe(false);
  });

  it('returns 500 when the usage query fails', async () => {
    mocks.usageFindAll.mockRejectedValue(new Error('db down'));

    const res = await request(makeApp()).get('/api/usage?range=7d');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build usage metrics.' });
  });
});
