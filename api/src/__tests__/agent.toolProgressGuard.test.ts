import { describe, expect, it } from 'vitest';
import { ToolProgressGuard } from '../agent/agentServer/toolProgressGuard';

function observe(guard: ToolProgressGuard, script: string, output: string) {
  return guard.afterRound(
    [{ id: Math.random().toString(), name: 'shell_script', arguments: { script } }],
    [{ result: output }],
  );
}

describe('tool progress guard', () => {
  it('stops repeated inspection evidence even when scripts and call IDs change', () => {
    const guard = new ToolProgressGuard();
    const evidence = 'Repository guidance and unchanged clean status. '.repeat(20);
    for (let i = 0; i < 8; i++)
      expect(observe(guard, `cat AGENTS.md; git status # ${i}`, evidence)).toBeUndefined();
    expect(observe(guard, 'cat ./AGENTS.md; git status', evidence)).toContain(
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
      expect(guard.beforeRound()).toBeUndefined();
      expect(observe(guard, `edit file${i}`, 'OK')).toBeUndefined();
    }
  });
  it('bounds even novel tool rounds', () => {
    const guard = new ToolProgressGuard();
    for (let i = 0; i < 120; i++) expect(guard.beforeRound()).toBeUndefined();
    expect(guard.beforeRound()).toContain('Paused after 120');
  });
});
