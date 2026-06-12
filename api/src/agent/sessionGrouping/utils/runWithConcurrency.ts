import { logger } from '../../../logger';

/**
 * Run an async function over each item in `items` with at most `limit`
 * concurrent executions. Used to parallelise per-group refresh and
 * per-session backfill within a subscription without unbounded fan-out
 * against the LLM provider. Individual item failures are logged and the
 * queue keeps draining — one bad item never blocks the rest of the tick.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (err) {
        logger.error('runWithConcurrency item failed', { error: err });
      }
    }
  };
  for (let i = 0; i < Math.max(1, limit); i++) workers.push(worker());
  await Promise.all(workers);
}
