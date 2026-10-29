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
    mocks.complete.mockReset();
    mocks.estimateHistoryTokens.mockImplementation(
      (history: unknown[]) => JSON.stringify(history).length,
    );
    mocks.getInputTokenBudget.mockReturnValue(24_000);
    mocks.getFixedHelperModel.mockReturnValue('fast-summary-model');
    mocks.update.mockResolvedValue([1]);
    mocks.complete.mockResolvedValue({
      content: JSON.stringify({
        goal: 'Preserve the earlier repo audit and findings.',
        completed: ['Inspected agentServer'],
        findings: ['raw history replay is the main cost driver'],
        nextSteps: [],
        blockers: [],
      }),
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
      expect.objectContaining({ maxTokens: 2400, temperature: 0 }),
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
    expect(compacted.map((m) => m.role)).toEqual([
      'system',
      'user',
      'user',
      'user',
      'assistant',
      'user',
    ]);
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

  it('does not create or use compact memory below half of the active model input budget', async () => {
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
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(buildCompactedHistoryForRequest(session)).toEqual(session.history);

    session.sessionMemory = 'premature old memory';
    session.sessionMemoryHistoryLength = 3;
    const requestHistory = buildHistoryForRequest(session, 'claude-opus-5');
    expect(requestHistory).toEqual(session.history);
    expect(requestHistory).not.toBe(session.history);
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

  it('preserves task context even when the remaining instructions exceed the budget', () => {
    mocks.getInputTokenBudget.mockReturnValue(1_400);
    const session = makeSession([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: `<user_input>${'original requirements '.repeat(100)}</user_input>` },
      { role: 'assistant', content: 'PR: https://example.com/pull/123' },
      { role: 'user', content: '<user_input>Push it</user_input>' },
    ]);
    const requestHistory = buildTrimmedHistoryForRequest(session, 'small-model');
    expect(requestHistory).toEqual(session.history);
  });

  it.each([false, true])(
    'retains the dashboard task on its first follow-up (summary fails: %s)',
    async (fail) => {
      const task =
        '<user_input><project_context>Repository /work/mono</project_context>Update the built-in dashboard organization filters</user_input>';
      const session = makeSession([
        { role: 'system', content: 'system' },
        { role: 'user', content: '<stored_instructions>Finish the PR</stored_instructions>' },
        { role: 'user', content: task },
        ...Array.from({ length: 30 }, (_, i): AIMessage[] => [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `call-${i}`, name: 'shell_script', arguments: {} }],
          },
          { role: 'tool', content: 'build output '.repeat(600), tool_call_id: `call-${i}` },
        ]).flat(),
        {
          role: 'assistant',
          content: 'Changes are on branch dashboard-filters, PR https://example.com/pull/123',
        },
        { role: 'user', content: '<user_input>Continue and push it</user_input>' },
      ]);
      const raw = JSON.stringify(session.history);
      mocks.complete.mockResolvedValueOnce({
        content: JSON.stringify({
          goal: 'Repo /work/mono',
          completed: ['branch dashboard-filters, PR https://example.com/pull/123'],
          findings: [],
          nextSteps: [],
          blockers: [],
        }),
        finish_reason: 'stop',
      });
      if (fail) mocks.complete.mockReset().mockRejectedValue(new Error('summary unavailable'));
      await ensureSessionMemory(session, 'dashboard-session', 'small-model', mocks.log as any);
      const request = buildTrimmedHistoryForRequest(session, 'small-model');
      expect(mocks.complete).toHaveBeenCalledTimes(1);
      const text = request.map((m) => m.content).join('\n');
      expect(text).toContain(task);
      expect(text).toContain('<stored_instructions>Finish the PR');
      expect(text).toContain('https://example.com/pull/123');
      expect(text).toContain('Continue and push it');
      expect(mocks.estimateHistoryTokens(request)).toBeLessThanOrEqual(21_600);
      expect(JSON.stringify(session.history)).toBe(raw);
      for (const result of request.filter((m) => m.role === 'tool')) {
        expect(
          request.some((m) => m.tool_calls?.some((call) => call.id === result.tool_call_id)),
        ).toBe(true);
      }
      if (!fail) {
        expect(mocks.complete.mock.calls[0][1][1].content).toContain('/work/mono');
        expect(text).toContain('<session_memory>');
      }
    },
  );

  it('summarizes a long first task at a complete tool boundary', async () => {
    const history: AIMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '<user_input>Work in /repo/one</user_input>' },
      { role: 'assistant', content: 'Starting work' },
      { role: 'user', content: '<user_input>Use branch fixed-filters</user_input>' },
      ...Array.from({ length: 15 }, (_, i): AIMessage[] => [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${i}`, name: 'shell_script', arguments: {} }],
        },
        { role: 'tool', content: 'output'.repeat(2_000), tool_call_id: `call-${i}` },
      ]).flat(),
      { role: 'assistant', content: 'next step' },
    ];
    const session = makeSession(history);
    await ensureSessionMemory(session, 'long-task', 'small-model', mocks.log as any);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const cut = session.sessionMemoryHistoryLength!;
    expect(cut).toBeGreaterThan(2);
    expect(history[cut].role).toBe('assistant');
    const request = buildTrimmedHistoryForRequest(session, 'small-model');
    expect(request.some((m) => m.content.includes('/repo/one'))).toBe(true);
    expect(
      request.some((m) => m.content === '<user_input>Use branch fixed-filters</user_input>'),
    ).toBe(true);
    expect(request.some((m) => m.content.includes('<session_memory>'))).toBe(true);
    expect(mocks.estimateHistoryTokens(request)).toBeLessThanOrEqual(21_600);
  });
  it('replays intervening authorization and changed requirements despite stale memory', () => {
    const human = [
      'Investigate only; wait for approval',
      'Approved: implement the fix',
      'Use a separate branch',
      'What is done so far?',
    ];
    const session = makeSession([
      { role: 'system', content: 'system' },
      ...human.flatMap(
        (content) =>
          [
            { role: 'user', content },
            { role: 'assistant', content: 'old work' },
          ] as AIMessage[],
      ),
    ]);
    session.sessionMemory = 'Implementation remains pending approval.';
    session.sessionMemoryHistoryLength = 7;
    const raw = JSON.stringify(session.history);
    const request = buildCompactedHistoryForRequest(session);
    expect(
      request
        .filter((m) => m.role === 'user' && !m.content.includes('<session_memory>'))
        .map((m) => m.content),
    ).toEqual(human);
    expect(request[0].content).toContain('does not revoke prior authorization');
    expect(JSON.stringify(session.history)).toBe(raw);
  });

  it.each(['length', 'invalid-json', 'missing-fields', 'token-cap'])(
    'rejects %s checkpoints without advancing the cursor and backs off',
    async (failure) => {
      const session = makeSession([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'Implement the fix' },
        { role: 'assistant', content: 'evidence '.repeat(2000) },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'working' },
        { role: 'user', content: 'status?' },
      ]);
      session.sessionMemory = 'last valid checkpoint';
      session.sessionMemoryHistoryLength = 1;
      const valid = JSON.stringify({
        goal: 'Implement',
        completed: [],
        findings: [],
        nextSteps: [],
        blockers: [],
      });
      mocks.complete.mockResolvedValue({
        content:
          failure === 'invalid-json'
            ? '{'
            : failure === 'missing-fields'
              ? '{"goal":"Implement"}'
              : valid,
        finish_reason: failure === 'length' ? 'length' : 'stop',
        usage: { completion_tokens: failure === 'token-cap' ? 2400 : 10 },
      });
      await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
      await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
      expect(mocks.complete).toHaveBeenCalledTimes(2);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(session.sessionMemoryHistoryLength).toBe(1);
      expect(session.sessionMemory).toBe('last valid checkpoint');
      expect(
        buildCompactedHistoryForRequest(session).some((m) => m.content === 'Implement the fix'),
      ).toBe(true);
    },
  );

  it('does not skip exchanges when a summary input exceeds its chunk budget', async () => {
    const history: AIMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Implement' },
    ];
    for (let i = 0; i < 80; i++)
      history.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: `c${i}`, name: 'shell_script', arguments: { script: `inspect-${i}` } },
          ],
        },
        { role: 'tool', tool_call_id: `c${i}`, content: `evidence-${i}: ` + 'x'.repeat(3000) },
      );
    const session = makeSession(history);
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    const cut = session.sessionMemoryHistoryLength!;
    expect(cut).toBeLessThan(history.length - 8);
    expect(history[cut].role).toBe('assistant');
    const transcript = mocks.complete.mock.calls[0][1][1].content;
    for (let i = 1; i < cut; i++) expect(transcript).toContain(`#${i} `);
    expect(transcript.length).toBeLessThan(62000);
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    expect(mocks.complete.mock.calls[1][1][1].content).toContain(`#${cut} `);
    expect(session.sessionMemoryHistoryLength).toBeGreaterThan(cut);
  });

  it('keeps the prior checkpoint if its database write fails', async () => {
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Implement' },
      { role: 'assistant', content: 'evidence '.repeat(2000) },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'status?' },
    ]);
    mocks.update.mockRejectedValueOnce(new Error('disk unavailable'));
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    expect(session.sessionMemory).toBeNull();
    expect(session.sessionMemoryHistoryLength).toBe(0);
  });
  it('does not commit a summary delivered after cancellation', async () => {
    const controller = new AbortController();
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Implement' },
      { role: 'assistant', content: 'evidence '.repeat(2000) },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'status?' },
    ]);
    session.signal = controller.signal;
    mocks.complete.mockImplementationOnce(async () => {
      controller.abort();
      return {
        content: JSON.stringify({
          goal: 'Implement',
          completed: [],
          findings: [],
          nextSteps: [],
          blockers: [],
        }),
        finish_reason: 'stop',
      };
    });
    await expect(
      ensureSessionMemory(session, 'session', 'model', mocks.log as any),
    ).rejects.toThrow('cancelled');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(session.sessionMemoryHistoryLength).toBe(0);
    expect(mocks.complete.mock.calls[0][2].signal).toBe(controller.signal);
  });
  it('does not recompact a small effective context just because the archive is large', async () => {
    mocks.getInputTokenBudget.mockReturnValue(88_000);
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Fix the chart' },
      { role: 'assistant', content: 'archived evidence '.repeat(10_000) },
      ...Array.from(
        { length: 12 },
        (_, i): AIMessage => ({
          role: 'assistant',
          content: `new inspection ${i}: ` + 'x'.repeat(900),
        }),
      ),
    ]);
    session.sessionMemory = 'Root cause established; edit the chart renderer.';
    session.sessionMemoryHistoryLength = 3;
    const cursor = session.sessionMemoryHistoryLength;
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(session.sessionMemoryHistoryLength).toBe(cursor);
    // A genuinely full effective request should still compact.
    for (let i = 0; i < 10; i++)
      session.history.push({ role: 'assistant', content: 'fresh evidence '.repeat(500) });
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(session.sessionMemoryHistoryLength).toBeGreaterThan(cursor);
  });

  it('retains a token-budgeted working set at complete tool boundaries', async () => {
    mocks.getInputTokenBudget.mockReturnValue(100_000);
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Fix the chart' },
      ...Array.from({ length: 60 }, (_, i): AIMessage[] => [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `c${i}`, name: 'shell_script', arguments: {} }],
        },
        { role: 'tool', tool_call_id: `c${i}`, content: `inspection ${i}: ` + 'x'.repeat(1800) },
      ]).flat(),
    ]);
    // Several contiguous chunks may be needed for a very large archive.
    for (let i = 0; i < 5; i++)
      await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    const tail = session.history.slice(session.sessionMemoryHistoryLength!);
    expect(tail.length).toBeGreaterThan(8);
    expect(tail[0].role).toBe('assistant');
    expect(
      buildCompactedHistoryForRequest(session).some((m) => m.content.includes('inspection 59:')),
    ).toBe(true);
    const calls = mocks.complete.mock.calls.length;
    await ensureSessionMemory(session, 'session', 'model', mocks.log as any);
    expect(mocks.complete).toHaveBeenCalledTimes(calls);
  });

  it('preserves explicit corrected findings and next actions verbatim after compaction', () => {
    const correction =
      '<progress_summary>The labels exist and overlap. interval={0} forces every tick. Next edit KnowledgeBasePanelBody.tsx.</progress_summary>';
    const session = makeSession([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Fix the chart' },
      {
        role: 'assistant',
        content: correction,
        tool_calls: [{ id: 'old', name: 'shell_script', arguments: {} }],
      },
      { role: 'tool', tool_call_id: 'old', content: 'old output' },
      { role: 'user', content: 'Continue' },
      { role: 'assistant', content: 'recent work' },
    ]);
    session.sessionMemory = 'Tick labels are missing.';
    session.sessionMemoryHistoryLength = 4;
    const request = buildCompactedHistoryForRequest(session);
    const note = request.find((m) => m.content === correction);
    expect(note).toEqual({ role: 'assistant', content: correction });
    expect(request[0].content).toContain('prefer their later corrections');
    expect(request.findIndex((m) => m.content === correction)).toBeLessThan(
      request.findIndex((m) => m.content === 'Continue'),
    );
    expect(request.some((m) => m.tool_call_id === 'old' || m.tool_calls?.length)).toBe(false);
  });
});
