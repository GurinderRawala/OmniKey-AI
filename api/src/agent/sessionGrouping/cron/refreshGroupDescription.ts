import { Op } from 'sequelize';
import { AgentSession } from '../../../models/agentSession';
import { logger } from '../../../logger';
import { generateGroupDescriptionFromSummaries } from '../llm';
import { extractProjectPath, extractUserInputs } from '../utils';

/**
 * In-memory marker tracking when each group's description was last
 * refreshed. Keyed by `${subscriptionId}::${groupName}`. Lost on worker
 * restart, which is fine — the first tick after restart re-stamps every
 * group once and then settles into the activity-gated steady state. We
 * deliberately do NOT persist this; `AgentSession.group_description_updated_at`
 * is the durable shadow that survives restarts.
 */
export const lastRefreshedAt = new Map<string, Date>();

export function refreshKey(subscriptionId: string, groupName: string): string {
  return `${subscriptionId}::${groupName}`;
}

/**
 * Refresh one group's description. Reads the last 15 sessions in the
 * group, identifies the dominant project root via direct-vote counting
 * + ancestor/descendant collapse, demotes any sessions whose root is
 * disjoint from the dominant one (one project = one group invariant),
 * then feeds the last 5 surviving sessions' `sessionSummary` rows into
 * `generateGroupDescriptionFromSummaries`.
 *
 * Skip-if-idle: bails without an LLM call when the group's newest
 * `lastActiveAt` is older than our last successful refresh marker, so
 * quiet groups cost nothing per tick.
 */
export async function refreshGroupDescription(
  subscriptionId: string,
  groupName: string,
  existingDescription: string | null,
): Promise<void> {
  try {
    // Skip-if-idle: only refresh when the group has had activity since the
    // last refresh. Saves an LLM call per group per tick on quiet groups.
    const newest = await AgentSession.findOne({
      where: { subscriptionId, groupName },
      order: [['last_active_at', 'DESC']],
      attributes: ['lastActiveAt'],
    });
    if (!newest) return;
    const lastRefresh = lastRefreshedAt.get(refreshKey(subscriptionId, groupName));
    if (lastRefresh && newest.lastActiveAt <= lastRefresh) {
      logger.debug('Group description refresh skipped — no activity since last refresh', {
        subscriptionId,
        groupName,
        lastRefresh,
        lastActiveAt: newest.lastActiveAt,
      });
      return;
    }

    // Pull a window of recent sessions in the group along with their
    // already-written sessionSummary. We use the SUMMARIES as the LLM's
    // recent-activity context rather than re-extracting from raw history —
    // summaries are produced when each session ends (see agentServer's
    // WebSocket close handler), so the cron's job is just to roll them
    // up into a group-level description, not to re-mine the history.
    const sessions = await AgentSession.findAll({
      where: { subscriptionId, groupName },
      order: [['last_active_at', 'DESC']],
      limit: 15,
      attributes: ['id', 'historyJson', 'sessionSummary', 'lastActiveAt'],
    });

    // Per-session inputs + each session's dominant project root + its
    // existing summary. The split logic below still needs the raw inputs
    // because the dominant-root computation is what tells us when a group
    // has drifted across multiple unrelated projects.
    type Resolved = {
      id: string;
      inputs: string[];
      root: string | null;
      summary: string | null;
      lastActiveAt: Date;
    };
    const resolved: Resolved[] = sessions.map((s) => {
      const inputs = extractUserInputs(s.historyJson);
      return {
        id: s.id,
        inputs,
        root: extractProjectPath(inputs),
        summary: s.sessionSummary ?? null,
        lastActiveAt: s.lastActiveAt,
      };
    });

    // Count direct votes per root (sessions with no detectable root don't
    // contribute to the split decision; they ride along with whatever wins).
    const rawRootCounts = new Map<string, number>();
    for (const r of resolved) {
      if (r.root) rawRootCounts.set(r.root, (rawRootCounts.get(r.root) ?? 0) + 1);
    }

    // Collapse roots that are in an ancestor/descendant relationship into
    // the SHALLOWEST one — they are the same project, just referenced at
    // different depths (e.g. one session edits files in /Users/me/Repo,
    // the next edits files in /Users/me/Repo/api). Without this collapse
    // the split logic would treat /Users/me/Repo and /Users/me/Repo/api
    // as two separate projects and demote half the group on every tick.
    const isAncestorOrEqual = (a: string, b: string): boolean =>
      a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
    const rawRoots = Array.from(rawRootCounts.keys());
    const canonicalOf = new Map<string, string>();
    for (const root of rawRoots) {
      let canonical = root;
      for (const other of rawRoots) {
        if (other === root) continue;
        if (isAncestorOrEqual(other, canonical)) canonical = other;
      }
      canonicalOf.set(root, canonical);
    }
    const rootCounts = new Map<string, number>();
    for (const [root, votes] of rawRootCounts.entries()) {
      const canon = canonicalOf.get(root) ?? root;
      rootCounts.set(canon, (rootCounts.get(canon) ?? 0) + votes);
    }

    // Dominant root: the canonical project most-referenced across sessions.
    // Ties are broken by shorter path (more likely the actual project root
    // when two truly disjoint trees somehow tie).
    const ranked = Array.from(rootCounts.entries()).sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : a[0].length - b[0].length,
    );
    const dominantRoot = ranked.length ? ranked[0][0] : null;

    // SPLIT: any session whose canonical root is non-null and DIFFERENT
    // from the dominant root does not belong in this group. We clear its
    // groupName/groupDescription so the next cron tick re-classifies it
    // into its own (likely new) group.
    if (dominantRoot) {
      const stragglerIds = resolved
        .filter((r) => {
          if (!r.root) return false;
          const canon = canonicalOf.get(r.root) ?? r.root;
          return canon !== dominantRoot;
        })
        .map((r) => r.id);
      if (stragglerIds.length > 0) {
        logger.info(
          'Splitting polluted group: demoting sessions whose root differs from the dominant root',
          {
            subscriptionId,
            groupName,
            dominantRoot,
            stragglerCount: stragglerIds.length,
            otherRoots: Array.from(rootCounts.entries())
              .filter(([r]) => r !== dominantRoot)
              .map(([r, n]) => `${r} (${n})`),
          },
        );
        await AgentSession.update(
          { groupName: null, groupDescription: null },
          { where: { id: { [Op.in]: stragglerIds } } },
        );
      }
    }

    // Collect SUMMARIES from the most-recent ~5 sessions that belong to
    // the dominant root.
    const recentSummaries: Array<{ summary: string; lastActiveAt: Date }> = [];
    for (const r of resolved) {
      if (dominantRoot && r.root) {
        const canon = canonicalOf.get(r.root) ?? r.root;
        if (canon !== dominantRoot) continue;
      }
      if (!r.summary) continue;
      recentSummaries.push({ summary: r.summary, lastActiveAt: r.lastActiveAt });
      if (recentSummaries.length >= 5) break;
    }

    if (!recentSummaries.length && !existingDescription) {
      // Nothing to write yet — no summaries available and no prior
      // description to refresh. Bail without paying an LLM call.
      lastRefreshedAt.set(refreshKey(subscriptionId, groupName), new Date());
      return;
    }

    const newDescription = await generateGroupDescriptionFromSummaries(
      groupName,
      dominantRoot,
      recentSummaries,
      existingDescription,
    );

    if (!newDescription) return;

    // Sync the updated description AND its timestamp to every session
    // that REMAINS in this group (excluding the just-demoted stragglers).
    // The timestamp lets buildProjectContext show "Group description last
    // updated: ..." so the agent knows how fresh the project meta is.
    const updatedAt = new Date();
    await AgentSession.update(
      { groupDescription: newDescription, groupDescriptionUpdatedAt: updatedAt },
      { where: { subscriptionId, groupName } },
    );

    lastRefreshedAt.set(refreshKey(subscriptionId, groupName), updatedAt);

    logger.info('Group description refreshed', { subscriptionId, groupName, dominantRoot });
  } catch (err) {
    logger.error('Failed to refresh group description', { subscriptionId, groupName, error: err });
  }
}
