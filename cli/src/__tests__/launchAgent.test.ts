import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync: mocks.exec }));
import { loadLaunchAgent } from '../launchAgent';
afterEach(() => {
  vi.useRealTimers();
  mocks.exec.mockReset();
});
const busy = () =>
  Object.assign(new Error('launchctl failed'), {
    stderr: Buffer.from('Load failed: 5: Input/output error'),
  });

it('retries while launchd finishes unloading the old daemon', async () => {
  vi.useFakeTimers();
  mocks.exec
    .mockImplementationOnce(() => {
      throw busy();
    })
    .mockReturnValueOnce(Buffer.alloc(0));
  const load = loadLaunchAgent('/tmp/daemon.plist');
  await vi.advanceTimersByTimeAsync(250);
  await load;
  expect(mocks.exec).toHaveBeenCalledTimes(2);
});

it('bounds retries if launchd remains unavailable', async () => {
  vi.useFakeTimers();
  mocks.exec.mockImplementation(() => {
    throw busy();
  });
  const result = expect(loadLaunchAgent('/tmp/daemon.plist')).rejects.toThrow('launchctl failed');
  await vi.advanceTimersByTimeAsync(15_000);
  await result;
  expect(mocks.exec).toHaveBeenCalledTimes(61);
});

it('surfaces non-transient errors immediately', async () => {
  mocks.exec.mockImplementation(() => {
    throw new Error('Permission denied');
  });
  await expect(loadLaunchAgent('/tmp/daemon.plist')).rejects.toThrow('Permission denied');
  expect(mocks.exec).toHaveBeenCalledTimes(1);
});
