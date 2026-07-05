import { describe, it, expect } from 'vitest';
import { isContextLengthError, pruneHistoryForContextLimit } from '../agent/utils';
import type { SessionState } from '../agent/types';
import type { AIMessage } from '../ai-client';

// Minimal stand-in for the winston Logger the helper only calls .warn on.
const noopLog = { warn: () => {} } as any;

function makeSession(history: AIMessage[]): SessionState {
  return { subscription: {} as any, history, turns: 1 };
}

describe('isContextLengthError', () => {
  it('detects OpenAI/nemotron context_length_exceeded code', () => {
    expect(isContextLengthError({ code: 'context_length_exceeded' })).toBe(true);
    expect(isContextLengthError({ error: { code: 'context_length_exceeded' } })).toBe(true);
  });

  it('detects the human-readable overflow message', () => {
    expect(
      isContextLengthError({
        message: '400 Your input exceeds the context window of this model.',
      }),
    ).toBe(true);
    expect(isContextLengthError({ message: 'prompt is too many tokens' })).toBe(true);
  });

  it('ignores unrelated errors and non-objects', () => {
    expect(isContextLengthError({ code: 'rate_limit_exceeded', message: 'slow down' })).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
    expect(isContextLengthError('boom')).toBe(false);
  });
});

describe('pruneHistoryForContextLimit', () => {
  it('compacts the single largest oversized message first', () => {
    const big = 'x'.repeat(50_000);
    const session = makeSession([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'small ask' },
      { role: 'assistant', content: big },
      { role: 'user', content: 'follow up' },
    ]);

    const changed = pruneHistoryForContextLimit(session, noopLog);

    expect(changed).toBe(true);
    // Same number of messages — compaction never removes messages, so pairing
    // and ordering are untouched.
    expect(session.history).toHaveLength(4);
    const compacted = session.history[2].content as string;
    expect(compacted.length).toBeLessThan(big.length);
    expect(compacted).toContain('chars omitted to fit the model context window');
    // The other messages are preserved verbatim.
    expect(session.history[1].content).toBe('small ask');
    expect(session.history[3].content).toBe('follow up');
  });

  it('drops the oldest assistant tool_call together with its tool results', () => {
    const session = makeSession([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [{ id: 't1', name: 'shell_script', arguments: {} }],
      },
      { role: 'tool', tool_call_id: 't1', tool_name: 'shell_script', content: 'result' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'latest question' },
    ]);

    const changed = pruneHistoryForContextLimit(session, noopLog);

    expect(changed).toBe(true);
    // Oldest unit is the "first turn" user message (a standalone unit).
    expect(session.history.map((m) => m.content)).toEqual([
      'sys',
      'calling tool',
      'result',
      'done',
      'latest question',
    ]);

    // Next prune removes the assistant tool_call AND its tool result as one block,
    // never leaving an orphaned tool_call or tool result.
    const changed2 = pruneHistoryForContextLimit(session, noopLog);
    expect(changed2).toBe(true);
    expect(session.history.map((m) => m.role)).toEqual(['system', 'assistant', 'user']);
    expect(session.history.some((m) => m.role === 'tool')).toBe(false);
  });

  it('returns false when only system and the final user turn remain', () => {
    const session = makeSession([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'only question' },
    ]);

    expect(pruneHistoryForContextLimit(session, noopLog)).toBe(false);
    expect(session.history).toHaveLength(2);
  });
});
