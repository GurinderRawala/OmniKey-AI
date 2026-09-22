import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIMessage } from '../ai-client';
import type { SessionState } from '../agent/types';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  estimateHistoryTokens: vi.fn((history: unknown[]) => JSON.stringify(history).length),
  getFixedHelperModel: vi.fn(() => 'fast-summary-model'),
  getInputTokenBudget: vi.fn(() => 24_000),
  update: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete },
  estimateHistoryTokens: mocks.estimateHistoryTokens,
  getFixedHelperModel: mocks.getFixedHelperModel,
  getInputTokenBudget: mocks.getInputTokenBudget,
}));

vi.mock('../config', () => ({
  config: { aiProvider: 'anthropic' },
}));

vi.mock('../models/agentSession', () => ({
  AgentSession: { update: mocks.update },
}));

import {
  buildCompactedHistoryForRequest,
  buildHistoryForRequest,
  buildTrimmedHistoryForRequest,
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
    mocks.getInputTokenBudget.mockReturnValue(24_000);
    mocks.getFixedHelperModel.mockReturnValue('fast-summary-model');
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

    await ensureSessionMemory(session, 'session-1', 'claude-haiku-4-5', mocks.log as any, onUsage);

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.calls[0][0]).toBe('fast-summary-model');
    expect(mocks.getFixedHelperModel).toHaveBeenCalledWith('anthropic');
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
    expect(buildHistoryForRequest(session, 'claude-haiku-4-5')).toEqual(compacted);
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

    await ensureSessionMemory(session, 'session-1', 'claude-haiku-4-5', mocks.log as any);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(buildCompactedHistoryForRequest(session)).toEqual(session.history);
  });

  it('backs off failed summaries instead of making a helper call on every tool step', async () => {
    mocks.complete.mockRejectedValue(new Error('helper unavailable'));
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'x'.repeat(40_000) },
      { role: 'user', content: 'previous task' },
      { role: 'user', content: 'current task' },
    ]);
    await ensureSessionMemory(session, 'session-1', 'model', mocks.log as any);
    await ensureSessionMemory(session, 'session-1', 'model', mocks.log as any);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(session.sessionMemory).toBeNull();
    expect(session.sessionMemoryRetryAfter).toBeGreaterThan(Date.now());
  });

  it('compacts expensive history well before half of a large context window', async () => {
    mocks.getInputTokenBudget.mockReturnValue(960_000);
    const oldLargeResult = 'old but still under half of opus context\n'.repeat(3_000);
    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '<user_input>First large task</user_input>' },
      { role: 'assistant', content: oldLargeResult },
      { role: 'user', content: '<user_input>Second task to keep raw</user_input>' },
      { role: 'assistant', content: 'second answer stays raw' },
      { role: 'user', content: '<user_input>Current follow-up stays raw</user_input>' },
    ]);

    await ensureSessionMemory(session, 'session-1', 'claude-opus-5', mocks.log as any);

    expect(mocks.getInputTokenBudget).toHaveBeenCalledWith('anthropic', 'claude-opus-5');
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(buildCompactedHistoryForRequest(session)).not.toEqual(session.history);

    session.sessionMemory = 'premature old memory';
    session.sessionMemoryHistoryLength = 3;
    const requestHistory = buildHistoryForRequest(session, 'claude-opus-5');
    expect(requestHistory).toEqual(buildCompactedHistoryForRequest(session));
    expect(requestHistory).not.toBe(session.history);
  });

  it('compacts within one long task without losing its request, stored instructions or tool pairs', async () => {
    const history: AIMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '<stored_instructions>repo rules</stored_instructions>' },
      { role: 'user', content: '<user_input>Fix the original bug</user_input>' },
    ];
    for (let i = 0; i < 8; i++) {
      history.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${i}`, name: 'shell_script', arguments: { script: 'test' } }],
        },
        { role: 'tool', tool_call_id: `call-${i}`, content: 'x'.repeat(4000) },
      );
    }
    const original = JSON.stringify(history);
    const session = makeSession(history);
    await ensureSessionMemory(session, 'session-1', 'test-model', mocks.log as any);
    expect(session.sessionMemoryHistoryLength).toBe(11);
    const request = buildHistoryForRequest(session, 'test-model');
    expect(request[1].content).toContain('repo rules');
    expect(request[3].content).toContain('Fix the original bug');
    expect(request.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual([
      'call-4',
      'call-5',
      'call-6',
      'call-7',
    ]);
    expect(JSON.stringify(session.history)).toBe(original);
  });

  it('keeps pending multi-call rounds intact and does not repeatedly summarize small growth', async () => {
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: '<user_input>Current task</user_input>' },
    ]);
    for (let i = 0; i < 6; i++) {
      session.history.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: `a${i}`, name: 'a', arguments: {} },
            { id: `b${i}`, name: 'b', arguments: {} },
          ],
        },
        { role: 'tool', tool_call_id: `a${i}`, content: 'x'.repeat(6000) },
      );
      if (i < 5) session.history.push({ role: 'tool', tool_call_id: `b${i}`, content: 'ok' });
    }
    await ensureSessionMemory(session, 'session-1', 'model', mocks.log as any);
    // Only one old complete round is eligible, below the minimum summary batch.
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(buildHistoryForRequest(session, 'model')).toEqual(session.history);
  });

  it('caps all tool results only in requests and subtracts schema overhead from the budget', () => {
    mocks.getInputTokenBudget.mockReturnValue(100_000);
    const output = 'HEAD' + 'x'.repeat(100_000) + 'TAIL';
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'mcp', name: 'mcp_test', arguments: {} }],
      },
      { role: 'tool', tool_call_id: 'mcp', content: output },
    ]);
    const request = buildTrimmedHistoryForRequest(session, 'model');
    expect(request.at(-1)!.content.length).toBeLessThan(16_200);
    expect(request.at(-1)!.content).toContain('HEAD');
    expect(request.at(-1)!.content).toContain('TAIL');
    expect(session.history.at(-1)!.content).toBe(output);
    const reduced = buildTrimmedHistoryForRequest(session, 'model', 'session-1', undefined, 80_000);
    expect(mocks.estimateHistoryTokens(reduced)).toBeLessThanOrEqual(10_000);
  });

  it('builds the same trimmed request view used for context-remaining estimates', () => {
    mocks.getInputTokenBudget.mockReturnValue(2_000);
    mocks.estimateHistoryTokens.mockImplementation(
      (history: unknown[]) => JSON.stringify(history).length / 10,
    );

    const hugeOldMessage = 'large old output\n'.repeat(5_000);
    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '<user_input>Old task</user_input>' },
      { role: 'assistant', content: hugeOldMessage },
      { role: 'user', content: '<user_input>Current task</user_input>' },
    ]);

    const requestHistory = buildTrimmedHistoryForRequest(session, 'claude-haiku-4-5');

    expect(requestHistory.at(-1)?.content).toContain('Current task');
    expect(requestHistory.some((message) => message.content === hugeOldMessage)).toBe(false);
    expect(mocks.estimateHistoryTokens(requestHistory)).toBeLessThanOrEqual(1_800);
  });

  it('does not silently fall back to a default smart model when no active agent model is set', () => {
    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '<user_input>Current task</user_input>' },
    ]);

    expect(() => buildTrimmedHistoryForRequest(session)).toThrow(
      'Agent active model is required for session memory budget resolution.',
    );

    session.sessionMemory = 'old memory';
    session.sessionMemoryHistoryLength = 1;

    expect(() => buildHistoryForRequest(session)).toThrow(
      'Agent active model is required for session memory budget resolution.',
    );
  });

  it('trims complete old user and assistant exchanges instead of stranding assistant turns', () => {
    mocks.getInputTokenBudget.mockReturnValue(1_400);
    mocks.estimateHistoryTokens.mockImplementation(
      (history: unknown[]) => JSON.stringify(history).length,
    );

    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: `<user_input>${'older user detail '.repeat(65)}</user_input>` },
      { role: 'assistant', content: 'old assistant answer that should be dropped with its user' },
      { role: 'user', content: '<user_input>Current task that must stay</user_input>' },
    ]);

    const requestHistory = buildTrimmedHistoryForRequest(session, 'claude-sonnet-4-5');

    expect(requestHistory.map((message) => message.role)).toEqual(['system', 'user']);
    expect(requestHistory[1].content).toContain('Current task that must stay');
    expect(requestHistory.some((message) => message.content.includes('old assistant answer'))).toBe(
      false,
    );
  });
});
