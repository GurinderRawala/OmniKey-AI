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

  it('detects the real Anthropic over-window message', () => {
    // Exact shape thrown by the Anthropic SDK: no machine code, ">" instead of
    // "exceed". Regression guard for the 400 that was killing agent turns.
    expect(
      isContextLengthError({
        status: 400,
        type: 'error',
        message:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1337986 tokens > 1000000 maximum"}}',
      }),
    ).toBe(true);
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

  it('drops the oldest user exchange together with its assistant and tool results', () => {
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
    expect(session.history.map((m) => m.content)).toEqual(['sys', 'latest question']);
    expect(session.history.some((m) => m.role === 'tool')).toBe(false);
  });

  it('repairs a stranded assistant tool_call together with its tool results', () => {
    const session = makeSession([
      { role: 'system', content: 'sys' },
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
    expect(session.history.map((m) => m.role)).toEqual(['system', 'user']);
    expect(session.history.some((m) => m.role === 'tool')).toBe(false);
  });

  it('repairs stranded prefixes with multiple consecutive tool-call rounds', () => {
    const session = makeSession([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: 'calling first tool',
        tool_calls: [{ id: 't1', name: 'shell_script', arguments: {} }],
      },
      { role: 'tool', tool_call_id: 't1', tool_name: 'shell_script', content: 'first result' },
      {
        role: 'assistant',
        content: 'calling second tool',
        tool_calls: [{ id: 't2', name: 'shell_script', arguments: {} }],
      },
      { role: 'tool', tool_call_id: 't2', tool_name: 'shell_script', content: 'second result' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'latest question' },
    ]);

    const changed = pruneHistoryForContextLimit(session, noopLog);

    expect(changed).toBe(true);
    expect(session.history.map((m) => m.content)).toEqual(['sys', 'latest question']);
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
