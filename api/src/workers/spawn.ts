import path from 'path';
import { Worker } from 'worker_threads';
import { logger } from '../logger';

/**
 * Messages sent from the main process to a worker thread.
 *
 * Each worker decides which message types it understands; unknown types are
 * logged and ignored so adding new commands is backwards compatible.
 */
export type WorkerCommand = { type: 'runJob'; jobId: string } | { type: 'shutdown' };

export interface ManagedWorker {
  name: string;
  worker: Worker;
  /** Send a typed command to the worker. No-op if the worker is not running. */
  postMessage: (msg: WorkerCommand) => void;
  /** Disable auto-restart and terminate the worker. */
  stop: () => Promise<void>;
}

// Distance (ms) between auto-restart attempts after an unexpected exit.
// Keeps a crashed worker from spinning a tight restart loop while still
// recovering quickly from transient errors.
const RESTART_DELAY_MS = 5_000;

/**
 * Resolve the on-disk path to a worker entry file.
 *
 * - Production / `yarn start`: the project is compiled to `dist/` and the
 *   running file's extension is `.js`. The compiled worker lives next to
 *   this file at `dist/workers/<name>.js`.
 * - Development / `yarn dev`: ts-node-dev runs the original `.ts` sources.
 *   `__filename` ends with `.ts`, so we point the worker at the matching
 *   `.ts` file and rely on `ts-node/register` (loaded via `execArgv`) to
 *   transpile it on the fly inside the worker thread.
 */
function resolveWorkerEntry(workerName: string): { entry: string; isTs: boolean } {
  const isTs = __filename.endsWith('.ts');
  const ext = isTs ? '.ts' : '.js';
  const entry = path.join(__dirname, `${workerName}${ext}`);
  return { entry, isTs };
}

/**
 * Spawn a worker thread and automatically restart it if it exits unexpectedly.
 *
 * The returned handle exposes a `postMessage()` method for typed RPC and a
 * `stop()` method that disables auto-restart before terminating the worker.
 */
export function spawnWorker(workerName: string): ManagedWorker {
  let stopped = false;
  let restartTimer: NodeJS.Timeout | null = null;

  const handle: ManagedWorker = {
    name: workerName,
    // Replaced by start(); seeded with a placeholder so TS is happy.
    worker: null as unknown as Worker,
    postMessage: (msg: WorkerCommand) => {
      const w = handle.worker;
      if (!w) {
        logger.warn('Dropping message to worker that has not started yet.', {
          workerName,
          messageType: msg.type,
        });
        return;
      }
      try {
        w.postMessage(msg);
      } catch (err) {
        logger.error('Failed to post message to worker.', {
          workerName,
          messageType: msg.type,
          error: err,
        });
      }
    },
    stop: async () => {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const w = handle.worker;
      if (!w) return;
      try {
        await w.terminate();
      } catch (err) {
        logger.error('Failed to terminate worker.', { workerName, error: err });
      }
    },
  };

  const start = () => {
    const { entry, isTs } = resolveWorkerEntry(workerName);
    const execArgv = isTs ? ['-r', 'ts-node/register/transpile-only'] : [];

    logger.info('Spawning background worker.', { workerName, entry });

    const worker = new Worker(entry, {
      execArgv,
      // Forward stdout/stderr through the parent so worker logs surface in the
      // same console / log aggregator as the main process.
      stdout: false,
      stderr: false,
    });
    handle.worker = worker;

    worker.on('error', (err) => {
      logger.error('Worker emitted error.', { workerName, error: err });
    });

    worker.on('exit', (code) => {
      if (stopped) {
        logger.info('Worker exited after stop.', { workerName, code });
        return;
      }
      logger.error('Worker exited unexpectedly; scheduling restart.', {
        workerName,
        code,
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
