import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bulkCreate: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
  getDialect: vi.fn(() => 'postgres'),
  findAll: vi.fn(),
  sessionFindOne: vi.fn(),
  sessionUpdate: vi.fn(),
  transaction: vi.fn(async (callback: (transaction: object) => Promise<void>) => callback({})),
}));

vi.mock('../db', () => ({
  sequelize: { getDialect: mocks.getDialect, transaction: mocks.transaction },
}));
vi.mock('../agent/mcpRuntime', () => ({ MCP_TOOL_PREFIX: 'mcp__' }));
vi.mock('../models/agentSession', () => ({
  AgentSession: { findOne: mocks.sessionFindOne, update: mocks.sessionUpdate },
}));
vi.mock('../models/agentTranscriptMessage', () => ({
  AgentTranscriptMessage: {
    bulkCreate: mocks.bulkCreate,
    create: mocks.create,
    destroy: mocks.destroy,
    findAll: mocks.findAll,
  },
}));

import {
  buildTranscript,
  completedTranscriptRevision,
  previewTranscript,
} from '../agent/agentServer/transcript';
import {
  readOrBackfillNormalizedTranscript,
  replaceNormalizedTranscript,
} from '../agent/agentServer/transcriptStore';

describe('normalized transcript source revisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDialect.mockReturnValue('postgres');
    mocks.sessionFindOne.mockResolvedValue({ id: 'owned' });
  });

  it('publishes nothing when the session id is not owned by the publisher', async () => {
    const history = [
      { role: 'user', content: '<user_input>Owner question</user_input>' },
      { role: 'assistant', content: '<final_answer>Owner answer</final_answer>' },
    ];
    const revision = completedTranscriptRevision(buildTranscript(history));
    // The id was deleted and recreated by another subscription.
    mocks.sessionFindOne.mockResolvedValue(null);

    const previews = await replaceNormalizedTranscript(
      'session-reused',
      history,
      revision ?? undefined,
      'sub-a',
    );

    expect(previews.at(-1)?.text).toBe('Owner answer');
    // Owner check runs inside the publication transaction, with a row lock.
    expect(mocks.sessionFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-reused', subscriptionId: 'sub-a' },
        transaction: expect.anything(),
        lock: true,
      }),
    );
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.bulkCreate).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects stale rows after a failed publish and rebuilds the current snapshot', async () => {
    const historyA = [
      { role: 'user', content: '<user_input>Question A</user_input>' },
      { role: 'assistant', content: '<final_answer>Answer A</final_answer>' },
    ];
    const historyB = [
      ...historyA,
      { role: 'user', content: '<user_input>Question B</user_input>' },
      { role: 'assistant', content: '<final_answer>Answer B</final_answer>' },
    ];
    const messagesA = buildTranscript(historyA);
    const revisionA = completedTranscriptRevision(messagesA);
    const revisionB = completedTranscriptRevision(buildTranscript(historyB));
    expect(revisionA).not.toBe(revisionB);

    // Represents rows left at A after the authoritative session update to B
    // succeeded but normalized publication failed.
    mocks.findAll.mockResolvedValue(
      previewTranscript(messagesA).map((message) => ({
        previewJson: JSON.stringify(message),
        sourceRevision: revisionA,
      })),
    );

    const result = await readOrBackfillNormalizedTranscript(
      'session-1',
      JSON.stringify(historyB),
      revisionB,
      'sub-a',
    );

    expect(result.at(-1)?.text).toBe('Answer B');
    expect(mocks.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 'session-1' } }),
    );
    expect(mocks.bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ sourceRevision: revisionB })]),
      expect.any(Object),
    );
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      { transcriptRevision: revisionB },
      { where: { id: 'session-1', subscriptionId: 'sub-a', transcriptRevision: revisionB } },
    );
  });

  it('changes revision and normalized rows when an incomplete turn follows a success', async () => {
    const completedHistory = [
      { role: 'user', content: '<user_input>Question A</user_input>' },
      { role: 'assistant', content: '<final_answer>Answer A</final_answer>' },
    ];
    const interruptedHistory = [
      ...completedHistory,
      { role: 'user', content: '<user_input>Question B</user_input>' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-b', name: 'shell_script', arguments: { script: 'swift test' } }],
      },
    ];
    const completedRevision = completedTranscriptRevision(buildTranscript(completedHistory));
    const interruptedRevision = completedTranscriptRevision(buildTranscript(interruptedHistory));

    expect(interruptedRevision).not.toBe(completedRevision);
    await replaceNormalizedTranscript(
      'session-interrupted',
      interruptedHistory,
      interruptedRevision ?? undefined,
      'sub-a',
    );

    expect(mocks.bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'session-interrupted',
          role: 'assistant',
          sourceRevision: interruptedRevision,
        }),
      ]),
      expect.any(Object),
    );
    const rows = mocks.bulkCreate.mock.calls[0][0] as Array<{ previewJson: string }>;
    const latest = JSON.parse(rows.at(-1)?.previewJson ?? '{}');
    expect(latest.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'shellCommand',
          activityId: 'call-b',
          activityPhase: 'started',
        }),
      ]),
    );
  });

  it('rebuilds stored rows that still carry a known-partial diff card', async () => {
    const partial = {
      id: 'sdiff_partial0001',
      fileCount: 1,
      repositoryCount: 1,
      createdAt: new Date().toISOString(),
      scope: 'working_tree',
      displayLimit: 300,
      recovered: true,
      recoveryIncomplete: true,
    };
    const history = [
      { role: 'user', content: '<user_input>Question</user_input>' },
      { role: 'assistant', content: '<final_answer>Answer</final_answer>', session_diff: partial },
    ];
    // Rows written before the known-partial filter: the card is in previewJson
    // and the stored revision still matches the session.
    const current = buildTranscript(history);
    const stale = current.map((message) =>
      message.role !== 'assistant'
        ? message
        : {
            ...message,
            blocks: (message.blocks ?? []).map((b) =>
              b.kind === 'finalAnswer' ? { ...b, sessionDiff: partial as any } : b,
            ),
          },
    );
    const oldRevision = completedTranscriptRevision(stale);
    mocks.findAll.mockResolvedValue(
      previewTranscript(stale).map((message) => ({
        previewJson: JSON.stringify(message),
        sourceRevision: oldRevision,
      })),
    );
    const result = await readOrBackfillNormalizedTranscript(
      'session-partial',
      JSON.stringify(history),
      oldRevision,
      'sub-a',
    );
    expect(JSON.stringify(result)).not.toContain('sdiff_partial0001');
    expect(result.at(-1)?.text).toBe('Answer');
    const newRevision = completedTranscriptRevision(current);
    expect(newRevision).not.toBe(oldRevision);
    expect(mocks.bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ sourceRevision: newRevision })]),
      expect.any(Object),
    );
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      { transcriptRevision: newRevision },
      {
        where: { id: 'session-partial', subscriptionId: 'sub-a', transcriptRevision: oldRevision },
      },
    );
  });

  it('backfills an interrupted tail instead of serving older completed rows', async () => {
    const completedHistory = [
      { role: 'user', content: '<user_input>Question A</user_input>' },
      { role: 'assistant', content: '<final_answer>Answer A</final_answer>' },
    ];
    const interruptedHistory = [
      ...completedHistory,
      { role: 'user', content: '<user_input>Question B</user_input>' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-b', name: 'shell_script', arguments: { script: 'swift test' } }],
      },
    ];
    const completedMessages = buildTranscript(completedHistory);
    const completedRevision = completedTranscriptRevision(completedMessages);
    const interruptedRevision = completedTranscriptRevision(buildTranscript(interruptedHistory));
    mocks.findAll.mockResolvedValue(
      previewTranscript(completedMessages).map((message) => ({
        previewJson: JSON.stringify(message),
        sourceRevision: completedRevision,
      })),
    );

    const result = await readOrBackfillNormalizedTranscript(
      'session-interrupted',
      JSON.stringify(interruptedHistory),
      interruptedRevision,
      'sub-a',
    );

    expect(result.at(-2)).toMatchObject({ role: 'user', text: 'Question B' });
    expect(result.at(-1)?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'shellCommand',
          activityId: 'call-b',
          activityPhase: 'started',
        }),
      ]),
    );
    expect(mocks.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 'session-interrupted' } }),
    );
  });

  it('publishes large SQLite transcripts through stable single-row inserts', async () => {
    const history = Array.from({ length: 6 }, (_, index) => [
      { role: 'user', content: `<user_input>Question ${index}</user_input>` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: `call-${index}`, name: 'web_search', arguments: { query: `query-${index}` } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: `call-${index}`,
        tool_name: 'web_search',
        content: 'x'.repeat(180_000),
      },
      { role: 'assistant', content: `<final_answer>Answer ${index}</final_answer>` },
    ]).flat();
    const revision = completedTranscriptRevision(buildTranscript(history));
    mocks.getDialect.mockReturnValue('sqlite');

    await replaceNormalizedTranscript('session-large', history, revision ?? undefined, 'sub-a');

    expect(mocks.bulkCreate).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(buildTranscript(history).length);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-large', sourceRevision: revision }),
      expect.any(Object),
    );
  });
});
