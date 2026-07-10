/**
 * Unit tests for the one-shot backfill that populates
 * `task_instruction_id` + `task_instruction_heading` on legacy
 * AgentSession rows.
 *
 * The DB is fully mocked so the test stays pure and fast. Coverage:
 *   - Happy path: session body matches a template → row is updated.
 *   - No `<stored_instructions>` block → skipped, row untouched.
 *   - Body doesn't match any template → left as unmatched, row untouched.
 *   - Corrupt historyJson → counted as an error but never throws.
 *   - Marker short-circuit: second call returns immediately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import winston from 'winston';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sessionFindAll: vi.fn(),
  sessionUpdate: vi.fn(),
  templateFindAll: vi.fn(),
  decompressString: vi.fn(),
}));

vi.mock('../db', () => ({
  sequelize: { query: mocks.query },
}));

vi.mock('../models/agentSession', () => ({
  AgentSession: {
    findAll: mocks.sessionFindAll,
    update: mocks.sessionUpdate,
  },
}));

vi.mock('../models/subscriptionTaskTemplate', () => ({
  SubscriptionTaskTemplate: {
    findAll: mocks.templateFindAll,
  },
}));

vi.mock('../compression', () => ({
  decompressString: mocks.decompressString,
}));

import { backfillSessionTaskInstructions } from '../agent/backfillTaskInstructions';

function makeLogger() {
  return winston.createLogger({
    silent: true,
    transports: [new winston.transports.Console({ silent: true })],
  });
}

function makeStoredInstructionsHistory(body: string): string {
  return JSON.stringify([
    { role: 'system', content: 'system prompt' },
    {
      role: 'user',
      content: `<stored_instructions>
# Stored Instructions

"""
${body}
"""
</stored_instructions>`,
    },
    { role: 'assistant', content: 'ack' },
  ]);
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.sessionFindAll.mockReset();
  mocks.sessionUpdate.mockReset();
  mocks.templateFindAll.mockReset();
  mocks.decompressString.mockReset();

  // decompressString is a pass-through in tests so we can compare bodies
  // as plain strings without the actual zlib round-trip.
  mocks.decompressString.mockImplementation((v: string | null | undefined) => v ?? null);

  // Default query behavior: ensure-table always succeeds, meta reads return
  // nothing (i.e. backfill has NOT yet run), meta writes succeed.
  //
  // Sequelize's `.query()` return shape differs by `type`:
  //   - No type (DDL / DML): `[results, metadata]`.
  //   - `type: QueryTypes.SELECT`: unwrapped array of rows.
  // The backfill uses SELECT for reads, so those must return a plain array.
  mocks.query.mockImplementation(async (sql: string) => {
    if (/CREATE TABLE IF NOT EXISTS system_meta/.test(sql)) return [[], undefined];
    if (/SELECT value FROM system_meta/.test(sql)) return [];
    if (/INSERT INTO system_meta/.test(sql)) return [[], undefined];
    if (/UPDATE system_meta/.test(sql)) return [[], undefined];
    return [[], undefined];
  });
});

describe('backfillSessionTaskInstructions', () => {
  it('updates the session when the stored body matches a template', async () => {
    mocks.sessionFindAll.mockResolvedValue([
      {
        id: 'sess_1',
        subscriptionId: 'sub_1',
        historyJson: makeStoredInstructionsHistory('You are a helpful coder.'),
      },
    ]);
    mocks.templateFindAll.mockResolvedValue([
      { id: 'tpl_coder', heading: 'Coder', instructions: 'You are a helpful coder.' },
      { id: 'tpl_other', heading: 'Other', instructions: 'unrelated body' },
    ]);

    await backfillSessionTaskInstructions(makeLogger());

    expect(mocks.sessionUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      { taskInstructionId: 'tpl_coder', taskInstructionHeading: 'Coder' },
      { where: { id: 'sess_1' } },
    );
  });

  it('skips sessions with no <stored_instructions> block', async () => {
    mocks.sessionFindAll.mockResolvedValue([
      {
        id: 'sess_2',
        subscriptionId: 'sub_1',
        historyJson: JSON.stringify([
          { role: 'system', content: 'system' },
          { role: 'user', content: 'hi' },
        ]),
      },
    ]);
    mocks.templateFindAll.mockResolvedValue([]);

    await backfillSessionTaskInstructions(makeLogger());

    expect(mocks.sessionUpdate).not.toHaveBeenCalled();
  });

  it('leaves sessions untouched when no template matches the stored body', async () => {
    mocks.sessionFindAll.mockResolvedValue([
      {
        id: 'sess_3',
        subscriptionId: 'sub_1',
        historyJson: makeStoredInstructionsHistory('body with no matching template'),
      },
    ]);
    mocks.templateFindAll.mockResolvedValue([
      { id: 'tpl_a', heading: 'A', instructions: 'a different body' },
    ]);

    await backfillSessionTaskInstructions(makeLogger());

    expect(mocks.sessionUpdate).not.toHaveBeenCalled();
  });

  it('never throws on a corrupt historyJson row', async () => {
    mocks.sessionFindAll.mockResolvedValue([
      { id: 'sess_bad', subscriptionId: 'sub_1', historyJson: '{not json' },
      {
        id: 'sess_good',
        subscriptionId: 'sub_1',
        historyJson: makeStoredInstructionsHistory('good body'),
      },
    ]);
    mocks.templateFindAll.mockResolvedValue([
      { id: 'tpl_good', heading: 'Good', instructions: 'good body' },
    ]);

    await backfillSessionTaskInstructions(makeLogger());

    // The bad row is skipped, the good one still gets updated.
    expect(mocks.sessionUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      { taskInstructionId: 'tpl_good', taskInstructionHeading: 'Good' },
      { where: { id: 'sess_good' } },
    );
  });

  it('caches templates per subscription so multiple sessions share one query', async () => {
    mocks.sessionFindAll.mockResolvedValue([
      {
        id: 'sess_1',
        subscriptionId: 'sub_shared',
        historyJson: makeStoredInstructionsHistory('shared body'),
      },
      {
        id: 'sess_2',
        subscriptionId: 'sub_shared',
        historyJson: makeStoredInstructionsHistory('shared body'),
      },
    ]);
    mocks.templateFindAll.mockResolvedValue([
      { id: 'tpl_shared', heading: 'Shared', instructions: 'shared body' },
    ]);

    await backfillSessionTaskInstructions(makeLogger());

    expect(mocks.templateFindAll).toHaveBeenCalledTimes(1);
    expect(mocks.sessionUpdate).toHaveBeenCalledTimes(2);
  });

  it('short-circuits when the marker row already exists', async () => {
    // Make the SELECT return a previously-recorded ISO timestamp so the
    // early-return branch fires before any session scan happens.
    mocks.query.mockImplementation(async (sql: string) => {
      if (/CREATE TABLE IF NOT EXISTS system_meta/.test(sql)) return [[], undefined];
      if (/SELECT value FROM system_meta/.test(sql)) {
        return [{ value: '2025-01-01T00:00:00.000Z' }];
      }
      return [[], undefined];
    });

    await backfillSessionTaskInstructions(makeLogger());

    expect(mocks.sessionFindAll).not.toHaveBeenCalled();
    expect(mocks.sessionUpdate).not.toHaveBeenCalled();
  });

  it('records the completion marker even when there are no candidates', async () => {
    mocks.sessionFindAll.mockResolvedValue([]);

    await backfillSessionTaskInstructions(makeLogger());

    const insertCalls = mocks.query.mock.calls.filter((c) =>
      /INSERT INTO system_meta/.test(c[0] as string),
    );
    expect(insertCalls.length).toBe(1);
  });
});
