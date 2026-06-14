/**
 * Public surface of the sessionGrouping package.
 *
 * The four entry points the rest of the app uses live in
 * ./sessionGrouping.ts (orchestration), with the LLM prompts in ./llm,
 * the cron in ./cron, and the pure utilities in ./utils. Importers should
 * pull everything from this index and not reach into sub-paths.
 *
 * Internal helpers are re-exported under `__testing__` for the unit
 * tests; the production code never reads that surface.
 */

// Orchestration entry points.
export { buildProjectContext, summariseSession, updateSessionGroup } from './sessionGrouping';
export type { BuildProjectContextResult, ProjectContextConfidence } from './sessionGrouping';

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
import {
  classifyGroup,
  generateGroupDescriptionFromSummaries,
  generateSessionSummary,
} from './llm';
import { lastRefreshedAt, refreshGroupDescription } from './cron';
import {
  extractProjectPath,
  extractStoredProjectPath,
  extractUserInputs,
  findGroupByExactPath,
  runWithConcurrency,
  stripInjectedWrappers,
  trimToProjectRoot,
  truncateOnSentenceBoundary,
} from './utils';
import { buildProjectContext, summariseSession } from './sessionGrouping';

export const __testing__ = {
  buildProjectContext,
  classifyGroup,
  extractProjectPath,
  extractStoredProjectPath,
  extractUserInputs,
  findGroupByExactPath,
  generateGroupDescriptionFromSummaries,
  generateSessionSummary,
  lastRefreshedAt,
  refreshGroupDescription,
  runWithConcurrency,
  stripInjectedWrappers,
  summariseSession,
  trimToProjectRoot,
  truncateOnSentenceBoundary,
};
