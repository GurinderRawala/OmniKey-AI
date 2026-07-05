import { logger } from '../../../logger';
import { regroupSubscriptionViaAgent } from '../agent/regroupViaAgent';

/**
 * One subscription's cron tick. Runs a SINGLE agent pass that sees all of the
 * subscription's recent sessions at once and, via the assign_session_groups
 * tool, classifies the ungrouped ones, refreshes every group's description +
 * verified project root, and fills in missing per-session summaries.
 *
 * This replaces the previous cascade of many small LLM calls (one description
 * refresh per group + one classification per ungrouped session), which decided
 * each session in isolation and tended to drift onto the wrong project root.
 * The agent can also verify candidate roots on disk with shell_script.
 */
export async function refreshAllSessionGroups(subscriptionId: string): Promise<void> {
  try {
    await regroupSubscriptionViaAgent(subscriptionId);
  } catch (err) {
    logger.error('Failed to refresh session groups for subscription', {
      subscriptionId,
      error: err,
    });
  }
}
