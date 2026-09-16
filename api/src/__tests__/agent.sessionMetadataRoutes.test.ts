import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  findAll: vi.fn(),
}));

vi.mock('../authMiddleware', () => ({
  authMiddleware: vi.fn((_req: unknown, res: any, next: () => void) => {
    res.locals.subscription = { id: 'subscription-1' };
    res.locals.logger = { error: vi.fn() };
    next();
  }),
}));
vi.mock('../models/agentSession', () => ({
  AgentSession: { findOne: mocks.findOne, findAll: mocks.findAll, destroy: vi.fn() },
}));
vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: vi.fn(async () => ({})),
  getAgentSettingsVersion: vi.fn(() => 1),
  selectedAgentModelForProvider: vi.fn(() => 'test-model'),
}));
vi.mock('../ai-client', () => ({ getContextWindowSize: vi.fn(() => 128_000) }));
vi.mock('../agent/sessionGrouping', () => ({ GROUPING_SESSION_PREFIX: 'grouping-' }));

import { createAgentRouter } from '../agent/agentServer/router';

function app() {
  const value = express();
  value.use(express.json());
  value.use('/api/agent', createAgentRouter());
  return value;
}

describe('agent session metadata routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trims and persists a renamed title without changing identity', async () => {
    const session = {
      id: 'session-1', title: 'Old title', isPinned: false,
      update: vi.fn(async (updates) => Object.assign(session, updates)),
    };
    mocks.findOne.mockResolvedValue(session);

    const response = await request(app()).patch('/api/agent/sessions/session-1').send({ title: '  New title  ' });

    expect(response.status).toBe(200);
    expect(session.update).toHaveBeenCalledWith({ title: 'New title' });
    expect(response.body).toEqual({ id: 'session-1', title: 'New title', isPinned: false });
  });

  it.each(['', '   ', '\n\t'])('rejects an empty title (%j)', async (title) => {
    const response = await request(app()).patch('/api/agent/sessions/session-1').send({ title });
    expect(response.status).toBe(400);
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it('persists pin and unpin state for the authenticated session', async () => {
    const session = {
      id: 'session-1', title: 'Title', isPinned: false,
      update: vi.fn(async (updates) => Object.assign(session, updates)),
    };
    mocks.findOne.mockResolvedValue(session);

    expect((await request(app()).patch('/api/agent/sessions/session-1').send({ isPinned: true })).body.isPinned).toBe(true);
    expect((await request(app()).patch('/api/agent/sessions/session-1').send({ isPinned: false })).body.isPinned).toBe(false);
  });

  it('does not expose a session owned by another subscription', async () => {
    mocks.findOne.mockResolvedValue(null);
    const response = await request(app()).patch('/api/agent/sessions/missing').send({ isPinned: true });
    expect(response.status).toBe(404);
    expect(mocks.findOne).toHaveBeenCalledWith({ where: { id: 'missing', subscriptionId: 'subscription-1' } });
  });
});
