import { parentPort } from 'worker_threads';
import { initDatabase } from '../db';
import { logger } from '../logger';
import type { WorkerCommand } from './spawn';
// Importing the models registers them with Sequelize before initDatabase()
// runs inside the worker. Workers share the same model definitions as the
// main process but each owns its own Sequelize connection.
import '../models/agentSession';
import '../models/scheduledJob';
import '../models/mcpServer';

export interface BootstrapOptions {
  /**
   * Optional handler invoked for every message the parent posts to this
   * worker. Unknown message types should be ignored — handlers run after the
   * built-in `shutdown` handler that the bootstrap installs unconditionally.
   */
  onMessage?: (msg: WorkerCommand) => void | Promise<void>;
}

/**
 * Initialize a background worker thread.
 *
 * Each worker owns its own Sequelize connection (db.ts is evaluated fresh in
 * the worker's V8 isolate), so DB calls performed here do not contend with
 * the main process's connection pool or block the HTTP event loop.
 *
 * The `run` callback receives the initialized logger and should kick off any
 * long-running schedulers. It must never throw — uncaught errors crash the
 * worker, and the parent will auto-restart it after a short delay.
 */
export async function bootstrapWorker(
  workerName: string,
  run: () => void | Promise<void>,
  options: BootstrapOptions = {},
): Promise<void> {
  try {
    await initDatabase(logger);
    logger.info('Worker database connection ready.', { workerName });

    await run();

    logger.info('Worker entry returned; scheduler is now active.', { workerName });
  } catch (err) {
    logger.error('Worker bootstrap failed.', { workerName, error: err });
    // Exit non-zero so the parent's `exit` handler treats this as a crash
    // and schedules a restart instead of silently leaving the worker dead.
    process.exit(1);
  }

  parentPort?.on('message', (raw) => {
    // Defensive: messages can technically be any structured-clone-safe value.
    const msg = raw as WorkerCommand | undefined;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      logger.warn('Worker received malformed message; ignoring.', { workerName, raw });
      return;
    }

    if (msg.type === 'shutdown') {
      logger.info('Worker received shutdown signal; exiting.', { workerName });
      process.exit(0);
    }

    if (options.onMessage) {
      void (async () => {
        try {
          await options.onMessage!(msg);
        } catch (err) {
          logger.error('Worker message handler threw.', {
            workerName,
            messageType: msg.type,
            error: err,
          });
        }
      })();
    }
  });
}
