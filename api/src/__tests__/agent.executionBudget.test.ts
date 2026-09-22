import { describe, expect, it, vi } from 'vitest';
import type { AICompletionResult } from '../ai-client';
import type { SessionState } from '../agent/types';

vi.mock('../config', () => ({ config: { agentMaxModelCalls: 2, agentMaxRunTokens: 100 } }));
import {
  accountModelCall,
  AgentBudgetExceededError,
  reserveModelCall,
} from '../agent/agentServer/executionBudget';

function session(): SessionState {
  return { subscription: {} as any, history: [], turns: 1 };
}

describe('agent execution budget', () => {
  it('limits attempts even when calls fail without usage', () => {
    const state = session();
    reserveModelCall(state);
    reserveModelCall(state);
    expect(() => reserveModelCall(state)).toThrow(AgentBudgetExceededError);
    expect(state.executionBudget?.calls).toBe(2);
  });

  it('counts actual total usage including cached input, with an estimate fallback', () => {
    const state = session();
    reserveModelCall(state);
    accountModelCall(state, { usage: { total_tokens: 80 } } as AICompletionResult, 1000);
    expect(state.executionBudget?.tokens).toBe(80);
    accountModelCall(state, {} as AICompletionResult, 20);
    expect(() => reserveModelCall(state)).toThrow(/follow-up to continue/);
  });
});
