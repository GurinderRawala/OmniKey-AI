import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWorker } from '../workers/spawn';
const mocks = vi.hoisted(() => ({ entry: '', forks: 0 }));
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    fork: (_entry: string, _args: string[], opts: object) => {
      mocks.forks++;
      return original.fork(mocks.entry, [], { ...opts, execArgv: [] });
    },
  };
});
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { spawnWorker } from '../workers/spawn';
let dir: string;
let worker: ManagedWorker | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-worker-test-'));
  mocks.entry = path.join(dir, 'worker.cjs');
  mocks.forks = 0;
  fs.writeFileSync(
    mocks.entry,
    `
    process.on('message', msg => process.send(msg));
    process.on('SIGTERM', () => process.exit(0));
    process.send({ ready: true });
  `,
  );
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('database worker process isolation', () => {
  it('survives a child killed by a fatal signal, restarts it, and delivers scheduled-job IPC', async () => {
    worker = spawnWorker('scheduledJobWorker');
    await once(worker.worker, 'message');
    const originalPid = worker.worker.pid;
    expect(originalPid).not.toBe(process.pid);
    const closed = once(worker.worker, 'close');
    worker.worker.kill('SIGKILL');
    await closed;
    await vi.waitFor(() => expect(mocks.forks).toBe(2), { timeout: 7_000, interval: 20 });
    const child = worker.worker;
    const reply = new Promise<unknown>((resolve) => {
      const onMessage = (message: { ready?: boolean }) => {
        if (message.ready) return;
        child.off('message', onMessage);
        resolve(message);
      };
      child.on('message', onMessage);
    });
    worker.postMessage({ type: 'runJob', jobId: 'job', sessionId: 'session' });
    const message = await reply;
    expect(message).toEqual({ type: 'runJob', jobId: 'job', sessionId: 'session' });
    expect(worker.worker.pid).not.toBe(originalPid);
    await worker.stop();
    expect(worker.worker.exitCode).toBe(0);
  }, 12_000);

  it('bounds shutdown of an unresponsive child and does not restart after stop', async () => {
    fs.writeFileSync(
      mocks.entry,
      `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send({ ready: true });`,
    );
    worker = spawnWorker('groupingWorker');
    await once(worker.worker, 'message');
    const stopping = worker.stop();
    expect(worker.stop()).toBe(stopping);
    await stopping;
    expect(worker.worker.signalCode).toBe('SIGKILL');
    expect(mocks.forks).toBe(1);
  }, 8_000);
});
