import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../config', () => ({ config: { isSelfHosted: true } }));
vi.mock('../models/subscription', () => ({ Subscription: { findOne: mocks.findOne } }));
vi.mock('../agent/defaultSelfHostedSeeds', () => ({
  seedDefaultSelfHostedAgentAssetsForSubscription: vi.fn(),
}));
vi.mock('../logger', () => ({ logger: { ...mocks.log, child: () => mocks.log } }));
import { authMiddleware } from '../authMiddleware';

describe('self-hosted database failure', () => {
  it('returns a retryable 503 rather than an unhandled rejection and serves the next request', async () => {
    const app = express();
    app.use(authMiddleware);
    app.get('/sessions', (_req, res) => res.json({ ok: true }));
    mocks.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    const failure = await request(app).get('/sessions');
    expect(failure.status).toBe(503);
    expect(failure.headers['retry-after']).toBe('1');
    expect(failure.body.error).not.toContain('SQLITE_BUSY');
    mocks.findOne.mockResolvedValueOnce({ id: 'local' });
    expect((await request(app).get('/sessions')).status).toBe(200);
  });
});
