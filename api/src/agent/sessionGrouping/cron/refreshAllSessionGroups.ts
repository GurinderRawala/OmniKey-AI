import { Op } from 'sequelize';
import { AgentSession } from '../../../models/agentSession';
import { logger } from '../../../logger';
import { runWithConcurrency } from '../utils';
import { refreshGroupDescription } from './refreshGroupDescription';
import { updateSessionGroup } from '../sessionGrouping';

/**
 * One subscription's cron tick. Refreshes every existing group's
 * description from per-session summaries, and classifies any ungrouped
 * sessions. Per-session summaries themselves are produced by the
 * session-end hook in the agent server, not here.
 */
export async function refreshAllSessionGroups(subscriptionId: string): Promise<void> {
  try {
    // Refresh descriptions for all existing groups (one LLM call per group,
    // gated by the per-group skip-if-idle check inside refreshGroupDescription).
    const groupRows = await AgentSession.findAll({
      where: {
        subscriptionId,
        groupName: { [Op.not]: null },
      },
      attributes: ['groupName', 'groupDescription'],
      group: ['group_name'],
    });

    // Ungrouped sessions: classify any that have never been grouped yet.
    // Limited to the 20 most recently active so a long-quiet account with
    // thousands of historical ungrouped sessions still makes forward
    // progress tick by tick instead of blowing past the LLM rate limit.
    const ungroupedSessions = await AgentSession.findAll({
      where: { subscriptionId, groupName: null },
      order: [['last_active_at', 'DESC']],
      limit: 20,
      attributes: ['id'],
    });

    logger.info('Refreshing session groups', {
      subscriptionId,
      groupCount: groupRows.length,
      ungroupedCount: ungroupedSessions.length,
    });

    // The cron's responsibilities here are intentionally narrow:
    //   1. Refresh existing groups' descriptions from sessions' already-
    //      written sessionSummary fields.
    //   2. Classify any sessions that don't yet have a group.
    // We do NOT generate or refresh per-session summaries here — those are
    // produced by the agent server's session-end hook. Driving summary
    // generation off session-end rather than off the hourly cron means
    // summaries reflect the user's most recent state immediately on
    // disconnect, not up to an hour later.
    await Promise.allSettled([
      runWithConcurrency(groupRows, 3, async (row) => {
        await refreshGroupDescription(subscriptionId, row.groupName!, row.groupDescription ?? null);
      }),
      runWithConcurrency(ungroupedSessions, 3, async (session) => {
        await updateSessionGroup(session.id, subscriptionId);
      }),
    ]);
  } catch (err) {
    logger.error('Failed to refresh session groups for subscription', {
      subscriptionId,
      error: err,
    });
  }
}
