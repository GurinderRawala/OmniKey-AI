import { afterEach, expect, it, vi } from 'vitest';
import { activeSessions } from '../agent/agentServer/runtimeState';
import { waitForAgentCheckpoints } from '../agent/agentServer/shutdown';

afterEach(() => {
  activeSessions.clear();
  vi.useRealTimers();
});

it('waits for cancelled agent turns to finish saving their checkpoints', async () => {
  vi.useFakeTimers();
  activeSessions.add('saving');
  let finished = false;
  const drain = waitForAgentCheckpoints(200).then((result) => {
    finished = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(finished).toBe(false);
  activeSessions.delete('saving');
  await vi.advanceTimersByTimeAsync(25);
  expect(await drain).toBe(true);
});

it('bounds shutdown even if a checkpoint cannot finish', async () => {
  vi.useFakeTimers();
  activeSessions.add('stuck');
  const drain = waitForAgentCheckpoints(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await drain).toBe(false);
});
