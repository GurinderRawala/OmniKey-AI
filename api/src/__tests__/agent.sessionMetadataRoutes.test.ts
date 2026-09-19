import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  findAll: vi.fn(),
  readFreshNormalizedTranscript: vi.fn(async () => []),
  readOrBackfillNormalizedTranscript: vi.fn(async () => []),
  readNormalizedBlockContent: vi.fn(),
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
vi.mock('../agent/agentServer/transcriptStore', () => ({
  readFreshNormalizedTranscript: mocks.readFreshNormalizedTranscript,
  readOrBackfillNormalizedTranscript: mocks.readOrBackfillNormalizedTranscript,
  readNormalizedBlockContent: mocks.readNormalizedBlockContent,
}));

import { createAgentRouter } from '../agent/agentServer/router';
import { transcriptContentId } from '../agent/agentServer/transcript';

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
      id: 'session-1',
      title: 'Old title',
      isPinned: false,
      update: vi.fn(async (updates) => Object.assign(session, updates)),
    };
    mocks.findOne.mockResolvedValue(session);

    const response = await request(app())
      .patch('/api/agent/sessions/session-1')
      .send({ title: '  New title  ' });

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
      id: 'session-1',
      title: 'Title',
      isPinned: false,
      update: vi.fn(async (updates) => Object.assign(session, updates)),
    };
    mocks.findOne.mockResolvedValue(session);

    expect(
      (await request(app()).patch('/api/agent/sessions/session-1').send({ isPinned: true })).body
        .isPinned,
    ).toBe(true);
    expect(
      (await request(app()).patch('/api/agent/sessions/session-1').send({ isPinned: false })).body
        .isPinned,
    ).toBe(false);
  });

  it('does not expose a session owned by another subscription', async () => {
    mocks.findOne.mockResolvedValue(null);
    const response = await request(app())
      .patch('/api/agent/sessions/missing')
      .send({ isPinned: true });
    expect(response.status).toBe(404);
    expect(mocks.findOne).toHaveBeenCalledWith({
      where: { id: 'missing', subscriptionId: 'subscription-1' },
    });
  });

  it('searches legacy transcript text without a second session query or backfill write', async () => {
    mocks.findAll.mockResolvedValue([
      {
        id: 'session-1',
        title: 'Project chat',
        groupName: null,
        groupDescription: null,
        transcriptRevision: 'revision-b',
        historyJson: JSON.stringify([
          { role: 'user', content: '<user_input>Find the hidden needle</user_input>' },
          { role: 'assistant', content: '<final_answer>Found it.</final_answer>' },
        ]),
      },
    ]);
    mocks.readFreshNormalizedTranscript.mockResolvedValueOnce(null as any);

    const response = await request(app()).get('/api/agent/sessions/search?q=needle');

    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        matchedText: expect.stringContaining('needle'),
      }),
    ]);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.readOrBackfillNormalizedTranscript).not.toHaveBeenCalled();
  });

  it('returns full oversized block content only through an owned session', async () => {
    mocks.findOne.mockResolvedValue({
      id: 'session-1',
      historyJson: JSON.stringify([
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: `<final_answer>${'x'.repeat(20_000)}</final_answer>` },
      ]),
    });
    mocks.readNormalizedBlockContent.mockResolvedValue('x'.repeat(20_000));

    const contentId = transcriptContentId({ kind: 'finalAnswer', text: 'x'.repeat(20_000) });
    const response = await request(app()).get(
      `/api/agent/sessions/session-1/message-blocks/${contentId}/content`,
    );

    expect(response.status).toBe(200);
    expect(response.body.contentLength).toBe(20_000);
    expect(response.body.text).toHaveLength(20_000);
    expect(mocks.readNormalizedBlockContent).toHaveBeenCalledWith('session-1', contentId);
    expect(mocks.findOne).toHaveBeenCalledWith({
      where: { id: 'session-1', subscriptionId: 'subscription-1' },
      attributes: ['id', 'transcriptRevision'],
    });
  });

  it('does not reveal block content from an unowned session', async () => {
    mocks.findOne.mockResolvedValue(null);
    const response = await request(app()).get(
      '/api/agent/sessions/other/message-blocks/block-0/content',
    );
    expect(response.status).toBe(404);
  });

  it('returns not found instead of different content for a stale content ID', async () => {
    mocks.findOne.mockResolvedValue({ id: 'session-1', updatedAt: new Date() });
    mocks.readNormalizedBlockContent.mockResolvedValue(null);

    const response = await request(app()).get(
      '/api/agent/sessions/session-1/message-blocks/content-stale-preview/content',
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Message block not found' });
    expect(mocks.readNormalizedBlockContent).toHaveBeenCalledWith(
      'session-1',
      'content-stale-preview',
    );
  });

  it('keeps the unversioned transcript response complete for older macOS clients', async () => {
    const largeAnswer = `Complete legacy answer\n\n${'x'.repeat(20_000)}`;
    const historyJson = JSON.stringify([
      { role: 'user', content: '<user_input>Legacy request</user_input>' },
      { role: 'assistant', content: `<final_answer>${largeAnswer}</final_answer>` },
    ]);
    mocks.findOne.mockResolvedValue({
      id: 'session-1',
      updatedAt: new Date(),
      historyJson,
    });

    const response = await request(app()).get('/api/agent/sessions/session-1/messages');

    expect(response.status).toBe(200);
    expect(response.body.pageInfo).toBeUndefined();
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[1].text).toBe(largeAnswer);
    expect(response.body.messages[1].blocks[0].isContentTruncated).toBeUndefined();
    expect(mocks.readFreshNormalizedTranscript).not.toHaveBeenCalled();
    expect(mocks.findOne).toHaveBeenCalledWith({
      where: { id: 'session-1', subscriptionId: 'subscription-1' },
      attributes: ['id', 'transcriptRevision', 'historyJson'],
    });
  });
});
