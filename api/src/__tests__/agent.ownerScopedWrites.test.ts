/**
 * Out-of-turn session writes stay scoped to the owning subscription, against a
 * real, isolated in-memory SQLite database (`../db` is replaced before any
 * model import; no env/live database). Only the grouping classifier is mocked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  classifyGroup: vi.fn(),
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() },
}));

vi.mock('../db', async () => {
  const { Sequelize } = await import('sequelize');
  return { sequelize: new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../agent/sessionGrouping/llm', () => ({ classifyGroup: mocks.classifyGroup }));

import { sequelize } from '../db';
import { Subscription } from '../models/subscription';
import { AgentSession } from '../models/agentSession';
import { AgentTranscriptMessage } from '../models/agentTranscriptMessage';
import { updateSessionGroup } from '../agent/sessionGrouping/sessionGrouping';
import { replaceNormalizedTranscript } from '../agent/agentServer/transcriptStore';

const history = [
  { role: 'user', content: '<user_input>\nowner task\n</user_input>' },
  { role: 'assistant', content: '<final_answer>\nowner answer\n</final_answer>' },
];

async function reuseIdForForeignSubscription(sessionId: string) {
  await AgentSession.destroy({ where: { id: sessionId } });
  await AgentSession.create({
    id: sessionId,
    subscriptionId: 'sub-b',
    title: 'Foreign',
    historyJson: '[]',
    turns: 0,
    lastActiveAt: new Date(),
  });
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await AgentTranscriptMessage.destroy({ where: {} });
  await AgentSession.destroy({ where: {} });
  await Subscription.destroy({ where: {} });
  await Subscription.bulkCreate([
    { id: 'sub-a', licenseKey: 'key-a', email: 'a@example.test' },
    { id: 'sub-b', licenseKey: 'key-b', email: 'b@example.test' },
  ]);
  await AgentSession.create({
    id: 'session-x',
    subscriptionId: 'sub-a',
    title: 'Owner',
    historyJson: JSON.stringify(history),
    turns: 1,
    lastActiveAt: new Date(),
  });
});

describe('owner-scoped out-of-turn writes (real SQLite)', () => {
  it('classifies and groups the owner session normally', async () => {
    mocks.classifyGroup.mockResolvedValue({ groupName: 'Owner Project' });

    await updateSessionGroup('session-x', 'sub-a');

    expect((await AgentSession.findByPk('session-x'))!.groupName).toBe('Owner Project');
  });

  it('never writes the owner group onto an id reused by another subscription mid-classification', async () => {
    mocks.classifyGroup.mockImplementation(async () => {
      await reuseIdForForeignSubscription('session-x');
      return { groupName: 'Owner Project' };
    });

    await updateSessionGroup('session-x', 'sub-a');

    const row = await AgentSession.findByPk('session-x');
    expect(row).toEqual(expect.objectContaining({ subscriptionId: 'sub-b', groupName: null }));
  });

  it('publishes transcript rows only for the owner of the session row', async () => {
    await replaceNormalizedTranscript('session-x', history, 'rev-owner', 'sub-a');
    expect(await AgentTranscriptMessage.count({ where: { sessionId: 'session-x' } })).toBe(2);

    // The id is reused by another subscription: the old owner's late
    // publication must neither clear nor write its rows.
    await AgentTranscriptMessage.destroy({ where: {} });
    await reuseIdForForeignSubscription('session-x');
    await AgentTranscriptMessage.create({
      id: 'session-x:foreign',
      sessionId: 'session-x',
      sequence: 0,
      messageId: 'foreign',
      role: 'user',
      text: 'foreign row',
      blocksJson: null,
      previewJson: '{}',
      sourceRevision: 'rev-foreign',
    });

    await replaceNormalizedTranscript('session-x', history, 'rev-owner', 'sub-a');

    const rows = await AgentTranscriptMessage.findAll({ where: { sessionId: 'session-x' } });
    expect(rows.map((r) => r.text)).toEqual(['foreign row']);
  });
});
