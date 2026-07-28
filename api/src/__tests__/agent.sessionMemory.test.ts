import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIMessage } from '../ai-client';
import type { SessionState } from '../agent/types';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  estimateHistoryTokens: vi.fn((history: unknown[]) => JSON.stringify(history).length),
  getDefaultModel: vi.fn((_provider: string, tier: string) =>
    tier === 'fast' ? 'fast-summary-model' : 'smart-model',
  ),
  update: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete },
  estimateHistoryTokens: mocks.estimateHistoryTokens,
  getDefaultModel: mocks.getDefaultModel,
}));

vi.mock('../config', () => ({
  config: { aiProvider: 'openai' },
}));

vi.mock('../models/agentSession', () => ({
  AgentSession: { update: mocks.update },
}));

import {
  buildCompactedHistoryForRequest,
  ensureSessionMemory,
} from '../agent/agentServer/sessionMemory';

function makeSession(history: AIMessage[]): SessionState {
  return {
    subscription: { id: 'subscription-1' } as any,
    history,
    turns: 3,
    sessionMemory: null,
    sessionMemoryHistoryLength: 0,
    sessionMemoryUpdatedAt: null,
  };
}

describe('agent session memory compaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.estimateHistoryTokens.mockImplementation(
      (history: unknown[]) => JSON.stringify(history).length,
    );
    mocks.update.mockResolvedValue([1]);
    mocks.complete.mockResolvedValue({
      content: [
        '## Goal',
        '- Preserve the earlier repo audit and findings.',
        '## Completed',
        '- Inspected agentServer and identified raw history replay as the main cost driver.',
      ].join('\n'),
      finish_reason: 'stop',
      model: 'fast-summary-model',
      assistantMessage: { role: 'assistant', content: 'summary' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it('summarizes old completed turns and builds a compact request history', async () => {
    const oldLargeResult = 'old bulky terminal and tool output\n'.repeat(600);
    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '<user_input>First costly task</user_input>' },
      { role: 'assistant', content: oldLargeResult },
      { role: 'user', content: '<user_input>Second task to keep raw</user_input>' },
      { role: 'assistant', content: 'second answer stays raw' },
      { role: 'user', content: '<user_input>Current follow-up stays raw</user_input>' },
    ]);
    const onUsage = vi.fn(async () => undefined);

    await ensureSessionMemory(session, 'session-1', mocks.log as any, onUsage);

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.calls[0][0]).toBe('fast-summary-model');
    expect(mocks.complete.mock.calls[0][2]).toEqual(
      expect.objectContaining({ maxTokens: 1400, temperature: 0 }),
    );
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'fast-summary-model' }));

    expect(session.sessionMemory).toContain('raw history replay');
    expect(session.sessionMemoryHistoryLength).toBe(3);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionMemory: expect.stringContaining('raw history replay'),
        sessionMemoryHistoryLength: 3,
        sessionMemoryUpdatedAt: expect.any(Date),
      }),
      { where: { id: 'session-1' } },
    );

    const compacted = buildCompactedHistoryForRequest(session);
    expect(compacted.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user']);
    expect(compacted[1].content).toContain('<session_memory>');
    expect(compacted.some((m) => m.content.includes(oldLargeResult.slice(0, 80)))).toBe(false);
    expect(compacted.map((m) => m.content).join('\n')).toContain('Second task to keep raw');
    expect(compacted.map((m) => m.content).join('\n')).toContain('Current follow-up stays raw');
  });

  it('does not pay for summarization while pending history is still small', async () => {
    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '<user_input>First small task</user_input>' },
      { role: 'assistant', content: 'small answer' },
      { role: 'user', content: '<user_input>Second small task</user_input>' },
      { role: 'assistant', content: 'another small answer' },
      { role: 'user', content: '<user_input>Current follow-up</user_input>' },
    ]);

    await ensureSessionMemory(session, 'session-1', mocks.log as any);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(buildCompactedHistoryForRequest(session)).toEqual(session.history);
  });
});
