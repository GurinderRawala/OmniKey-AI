import { initDatabase, sequelize } from '../db';
import { logger } from '../logger';
import type { WorkerCommand } from './spawn';
// Importing the models registers them with Sequelize before initDatabase()
// runs inside the worker. Workers share the same model definitions as the
// main process but each owns its own Sequelize connection.
import '../models/agentSession';
import '../models/scheduledJob';
import '../models/mcpServer';
import '../models/subscriptionTaskTemplate';
import '../models/subscriptionUsage';
import '../models/agentSettings';
import '../models/agentTranscriptMessage';
import '../models/agentSessionDiff';

export interface BootstrapOptions {
  /**
   * Optional handler invoked for every message the parent posts to this
   * worker. Unknown message types should be ignored — handlers run after the
   * built-in `shutdown` handler that the bootstrap installs unconditionally.
   */
  onMessage?: (msg: WorkerCommand) => void | Promise<void>;
}

/**
 * Initialize a background worker process.
 *
 * Each worker owns its own Sequelize connection (db.ts is evaluated fresh in
 * the worker process), so DB calls performed here do not contend with
 * the HTTP event loop (SQLite file locks are still shared).
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
  let stopping = false;
  let markReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    markReady = resolve;
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    logger.info('Worker shutting down.', { workerName });
    // The supervisor also enforces a deadline. A native abort here can only
    // terminate this child process, never the HTTP server.
    const timer = setTimeout(() => process.exit(1), 4_000);
    void sequelize.close().then(
      () => {
        clearTimeout(timer);
        process.exit(0);
      },
      (error) => {
        logger.error('Worker database close failed.', { workerName, error });
        clearTimeout(timer);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  // Do not leave schedulers orphaned when the parent crashes or is killed.
  process.once('disconnect', shutdown);

  process.on('message', (raw) => {
    if (stopping) return;
    // Defensive: messages can technically be any structured-clone-safe value.
    const msg = raw as WorkerCommand | undefined;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      logger.warn('Worker received malformed message; ignoring.', { workerName, raw });
      return;
    }

    if (msg.type === 'shutdown') {
      logger.info('Worker received shutdown signal; exiting.', { workerName });
      shutdown();
      return;
    }

    if (options.onMessage) {
      void (async () => {
        try {
          if (!(await ready) || stopping) return;
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
  try {
    await initDatabase(logger);
    if (stopping) {
      markReady(false);
      return;
    }
    logger.info('Worker database connection ready.', { workerName });

    await run();
    markReady(true);

    logger.info('Worker entry returned; scheduler is now active.', { workerName });
  } catch (err) {
    markReady(false);
    logger.error('Worker bootstrap failed.', { workerName, error: err });
    // Exit non-zero so the parent's `exit` handler treats this as a crash
    // and schedules a restart instead of silently leaving the worker dead.
    process.exit(1);
  }
}
