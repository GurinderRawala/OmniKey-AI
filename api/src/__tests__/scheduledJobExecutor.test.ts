import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), subscription: vi.fn() }));
vi.mock('../models/scheduledJob', () => ({ ScheduledJob: {} }));
vi.mock('../models/subscription', () => ({ Subscription: { findByPk: mocks.subscription } }));
vi.mock('../agent/agentServer', () => ({ runAgentTurn: mocks.run }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { executeJob } from '../scheduledJobExecutor';
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
