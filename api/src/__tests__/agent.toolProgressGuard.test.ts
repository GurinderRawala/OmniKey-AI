import { describe, expect, it } from 'vitest';
import { ToolProgressGuard } from '../agent/agentServer/toolProgressGuard';

function observe(guard: ToolProgressGuard, script: string, output: string) {
  return guard.afterRound(
    [{ id: Math.random().toString(), name: 'shell_script', arguments: { script } }],
    [{ result: output }],
  );
}

describe('tool progress guard', () => {
  it('stops identical inspections even when call IDs change', () => {
    const guard = new ToolProgressGuard();
    const evidence = 'Repository guidance and unchanged clean status. '.repeat(20);
    for (let i = 0; i < 8; i++)
      expect(observe(guard, 'cat AGENTS.md; git status', evidence)).toBeUndefined();
    expect(observe(guard, 'cat AGENTS.md; git status', evidence)).toContain(
      'evidence already seen',
    );
  });
  it('recognizes cycles and resets the streak when there is new evidence', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 9; i++)
      expect(observe(guard, `inspect ${i % 2}`, `result ${i % 2}`)).toBeUndefined();
    expect(observe(guard, 'edit new file', 'OK')).toBeUndefined();
    expect(observe(guard, 'inspect 0', 'result 0')).toBeUndefined();
  });
  it('allows distinct edits returning the same short acknowledgement', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 30; i++) {
      expect(observe(guard, `edit file${i}`, 'OK')).toBeUndefined();
    }
  });
  it('allows productive work beyond 120 rounds without an arbitrary cutoff', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 300; i++) {
      expect(observe(guard, `edit file${i}`, `updated file ${i}`)).toBeUndefined();
      expect(guard.takeRecoveryPrompt()).toBeUndefined();
    }
  });
  it('offers recovery before stopping an exact repetition loop', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 5; i++)
      expect(observe(guard, 'cat AGENTS.md', 'same guidance')).toBeUndefined();
    expect(guard.takeRecoveryPrompt()).toContain('next unfinished action');
    expect(guard.takeRecoveryPrompt()).toBeUndefined();
    expect(observe(guard, 'apply edit', 'updated renderer')).toBeUndefined();
    for (let i = 0; i < 4; i++)
      expect(observe(guard, 'cat AGENTS.md', 'same guidance')).toBeUndefined();
  });
  it('recognizes recombined, filtered inspections with changing headers', () => {
    const guard = new ToolProgressGuard();
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Repository instruction ${i}: use existing conventions and focused tests.`,
    );
    observe(guard, 'cat AGENTS.md', lines.join('\n'));
    for (let i = 0; i < 6; i++) {
      const output =
        `[terminal output refined: kept ${40 - i} lines]\n` +
        lines.slice(i, 40).reverse().join('\n');
      expect(observe(guard, `sed -n '${i},40p' AGENTS.md`, output)).toBeUndefined();
    }
    expect(guard.takeRecoveryPrompt()).toContain('Do not restart repository instruction discovery');
  });
  it('never hard-stops similar outputs with distinct new evidence', () => {
    const guard = new ToolProgressGuard();
    const common = Array.from(
      { length: 30 },
      (_, i) => `Test setup line ${i}: existing shared fixture initialization`,
    ).join('\n');
    for (let i = 0; i < 160; i++) {
      expect(observe(guard, `test file${i}`, `${common}\nTest file ${i} passed`)).toBeUndefined();
      guard.takeRecoveryPrompt();
    }
  });
  it('does not mistake distinct edits with identical long output for a loop', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 160; i++) {
      expect(observe(guard, `edit file${i}`, 'Successful change. '.repeat(50))).toBeUndefined();
      guard.takeRecoveryPrompt();
    }
  });
});
