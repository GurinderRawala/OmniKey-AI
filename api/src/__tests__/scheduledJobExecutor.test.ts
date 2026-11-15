import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), subscription: vi.fn() }));
vi.mock('../models/scheduledJob', () => ({ ScheduledJob: {} }));
vi.mock('../models/subscription', () => ({ Subscription: { findByPk: mocks.subscription } }));
vi.mock('../agent/agentServer', () => ({ runAgentTurn: mocks.run }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { computeNextRunAt, executeJob } from '../scheduledJobExecutor';
beforeEach(() => {
  vi.useFakeTimers();
  mocks.run.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.subscription.mockResolvedValue({ id: 'sub' });
});
afterEach(() => vi.useRealTimers());
it('aborts initial and recovery turns when the scheduled job times out', async () => {
  const job = {
    id: 'job',
    subscriptionId: 'sub',
    prompt: 'Work',
    update: vi.fn().mockResolvedValue(undefined),
  } as any;
  const pending = executeJob(job, 'session');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  const signal = mocks.run.mock.calls[0][5].signal;
  mocks.run.mock.calls[0][3]({ content: 'retry', is_error: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.run.mock.calls[1][5].signal).toBe(signal);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(600_000);
  await pending;
  expect(signal.aborted).toBe(true);
  expect(job.update).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
});

it('preserves recurring cron schedules with cron-parser 5', () => {
  vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  expect(computeNextRunAt('*/5 * * * *', null)?.toISOString()).toBe('2026-01-01T12:05:00.000Z');
  expect(computeNextRunAt('not a cron expression', null)).toBeNull();
});

it('preserves future one-off dates and rejects expired schedules', () => {
  vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  const future = new Date('2026-01-01T13:00:00.000Z');
  expect(computeNextRunAt(null, future)).toBe(future);
  expect(computeNextRunAt(null, new Date('2026-01-01T11:00:00.000Z'))).toBeNull();
  expect(computeNextRunAt(null, null)).toBeNull();
});
