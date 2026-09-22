import { config } from '../../config';
import type { AICompletionResult } from '../../ai-client';
import type { SessionState } from '../types';

export class AgentBudgetExceededError extends Error {
  constructor() {
    super(
      'The agent reached this run’s usage limit. Work so far has been saved. Send a follow-up to continue from this checkpoint.',
    );
    this.name = 'AgentBudgetExceededError';
  }
}

export function reserveModelCall(session: SessionState, estimatedInput = 0): void {
  const budget = (session.executionBudget ??= { calls: 0, tokens: 0 });
  if (
    budget.calls >= (config.agentMaxModelCalls ?? 100) ||
    budget.tokens >= (config.agentMaxRunTokens ?? 2_000_000) ||
    budget.tokens + estimatedInput > (config.agentMaxRunTokens ?? 2_000_000)
  ) {
    throw new AgentBudgetExceededError();
  }
  budget.calls++;
}

// Count cached tokens too: caching reduces price, not the amount of work.
// When a provider omits usage, charge the input estimate instead of allowing
// unmetered runs. The limit is checked between calls, not mid-generation.
export function accountModelCall(
  session: SessionState,
  result: AICompletionResult,
  estimatedInput: number,
): void {
  const budget = (session.executionBudget ??= { calls: 0, tokens: 0 });
  budget.tokens += result.usage?.total_tokens ?? estimatedInput;
}
