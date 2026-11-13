import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { logger } from '../logger';

export type WorkerCommand =
  | { type: 'runJob'; jobId: string; sessionId?: string }
  | { type: 'shutdown' };

export interface ManagedWorker {
  name: string;
  worker: ChildProcess;
  postMessage: (msg: WorkerCommand) => void;
  stop: () => Promise<void>;
}

const RESTART_DELAY_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

/** Database schedulers run in processes, not worker threads: sqlite3 can abort
 * during native callback teardown in a thread, taking the HTTP server with it.
 * A child crash is isolated, releases its OS locks, and can be restarted safely.
 */
export function spawnWorker(workerName: string): ManagedWorker {
  let stopped = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let stopPromise: Promise<void> | null = null;

  const handle: ManagedWorker = {
    name: workerName,
    worker: null as unknown as ChildProcess,
    postMessage: (msg) => {
      const worker = handle.worker;
      if (stopped || !worker?.connected) {
        logger.warn('Dropping message to unavailable worker.', {
          workerName,
          messageType: msg.type,
        });
        return;
      }
      worker.send(msg, (error) => {
        if (error) logger.error('Failed to send message to worker.', { workerName, error });
      });
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const worker = handle.worker;
      if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null)
        return Promise.resolve();
      stopPromise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => worker.kill('SIGKILL'), STOP_TIMEOUT_MS);
        worker.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        // The child handles SIGTERM even if the IPC channel is unavailable.
        worker.kill('SIGTERM');
      });
      return stopPromise;
    },
  };

  const start = () => {
    const isTs = __filename.endsWith('.ts');
    const entry = path.join(__dirname, `${workerName}${isTs ? '.ts' : '.js'}`);
    logger.info('Spawning background worker process.', { workerName, entry });
    const worker = fork(entry, [], {
      execArgv: isTs ? ['-r', 'ts-node/register/transpile-only'] : [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    handle.worker = worker;
    worker.on('error', (error) => {
      logger.error('Worker process error.', { workerName, error });
    });
    // close also fires on spawn failure, when there is no exit event.
    worker.once('close', (code, signal) => {
      if (stopped) {
        logger.info('Worker exited after stop.', { workerName, code, signal });
        return;
      }
      logger.error('Worker exited unexpectedly; scheduling restart.', {
        workerName,
        code,
        signal,
        restartDelayMs: RESTART_DELAY_MS,
      });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopped) start();
      }, RESTART_DELAY_MS);
    });
  };
  start();
  return handle;
}
