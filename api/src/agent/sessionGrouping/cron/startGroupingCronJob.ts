import { Subscription } from '../../../models/subscription';
import { logger } from '../../../logger';
import { runWithConcurrency } from '../utils';
import { refreshAllSessionGroups } from './refreshAllSessionGroups';

/**
 * Cron: runs hourly across all subscriptions.
 *
 * Each tick:
 *   1. Lists every subscription.
 *   2. For each subscription, refreshes existing group descriptions
 *      (gated by activity since last refresh) and classifies up to 20
 *      ungrouped sessions.
 *
 * Per-tick invariants:
 *   - Only one tick runs at a time. If a tick exceeds the interval, the
 *     next one is skipped instead of overlapping (overlap caused
 *     duplicate LLM calls and racy AgentSession.update writes in earlier
 *     versions).
 *   - Subscriptions are processed concurrently with a small concurrency cap.
 *   - An initial tick runs ~5 seconds after worker boot so sessions
 *     written while the worker was down do not have to wait a full hour
 *     to be grouped.
 */
export const GROUPING_TICK_INTERVAL_MS = 60 * 60 * 1_000;
export const GROUPING_INITIAL_TICK_DELAY_MS = 5_000;
export const GROUPING_SUBSCRIPTION_CONCURRENCY = 3;

export function startGroupingCronJob(): void {
  let tickInFlight = false;

  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      logger.warn('Skipping session grouping tick — previous tick still running');
      return;
    }
    tickInFlight = true;
    const startedAt = Date.now();
    try {
      const subscriptions = await Subscription.findAll({ attributes: ['id'] });
      logger.info('Running session grouping cron', {
        subscriptionCount: subscriptions.length,
      });
      await runWithConcurrency(subscriptions, GROUPING_SUBSCRIPTION_CONCURRENCY, async (sub) => {
        await refreshAllSessionGroups(sub.id);
      });
      logger.info('Session grouping cron tick completed', {
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      logger.error('Session grouping cron failed', { error: err });
    } finally {
      tickInFlight = false;
    }
  };

  setInterval(() => void tick(), GROUPING_TICK_INTERVAL_MS);
  logger.info('Session grouping cron started', {
    intervalMs: GROUPING_TICK_INTERVAL_MS,
  });

  // Always run an initial tick shortly after boot.
  setTimeout(() => void tick(), GROUPING_INITIAL_TICK_DELAY_MS);
}
