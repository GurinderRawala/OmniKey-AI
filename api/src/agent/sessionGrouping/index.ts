/**
 * Public surface of the sessionGrouping package.
 *
 * The entry points the rest of the app uses live in ./sessionGrouping.ts
 * (orchestration), with the session-end classifier in ./llm, the agent-driven
 * cron pass in ./agent, the cron scheduler in ./cron, and the pure utilities in
 * ./utils. Importers should pull everything from this index and not reach into
 * sub-paths.
 *
 * Internal helpers are re-exported under `__testing__` for the unit tests; the
 * production code never reads that surface.
 */

// Orchestration entry points.
export { buildProjectContext, updateSessionGroup } from './sessionGrouping';
export type { BuildProjectContextResult, ProjectContextConfidence } from './sessionGrouping';

// Prefix of the internal helper sessions the grouping cron spins up. Exposed so
// the agent server can exclude them from user-facing session/group listings.
export { GROUPING_SESSION_PREFIX } from './agent/regroupViaAgent';

// Cron entry points.
export {
  GROUPING_INITIAL_TICK_DELAY_MS,
  GROUPING_SUBSCRIPTION_CONCURRENCY,
  GROUPING_TICK_INTERVAL_MS,
  refreshAllSessionGroups,
  startGroupingCronJob,
} from './cron';

// ---------------------------------------------------------------------------
// __testing__ — bundle of internal helpers exposed for unit-test access.
// Not part of the production-facing API. New tests should import from
// here so a future internal refactor never breaks them.
// ---------------------------------------------------------------------------
import { classifyGroup } from './llm';
import {
  createAssignSessionGroupsHandler,
  ASSIGN_SESSION_GROUPS_TOOL,
} from './agent/assignSessionGroupsTool';
import { regroupSubscriptionViaAgent, groupingSessionId } from './agent/regroupViaAgent';
import {
  extractProjectPath,
  extractStoredProjectPath,
  extractUserInputs,
  findGroupByExactPath,
  isCatchAllGroupName,
  runWithConcurrency,
  stripInjectedWrappers,
  trimToProjectRoot,
  truncateOnSentenceBoundary,
} from './utils';
import { buildProjectContext } from './sessionGrouping';

export const __testing__ = {
  buildProjectContext,
  classifyGroup,
  createAssignSessionGroupsHandler,
  ASSIGN_SESSION_GROUPS_TOOL,
  extractProjectPath,
  extractStoredProjectPath,
  extractUserInputs,
  findGroupByExactPath,
  isCatchAllGroupName,
  groupingSessionId,
  regroupSubscriptionViaAgent,
  runWithConcurrency,
  stripInjectedWrappers,
  trimToProjectRoot,
  truncateOnSentenceBoundary,
};
