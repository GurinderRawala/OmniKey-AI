import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressReporter } from '../agent/agentServer/progressReporter';
import { buildTranscript } from '../agent/agentServer/transcript';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('progress reporting during silent runs', () => {
  it('reports only fresh completed work after silence and throttles repeated calls', () => {
    const reporter = new ProgressReporter();
    reporter.noteToolCompletion({ kind: 'tool' });
    expect(reporter.reportIfDue()).toBeNull();
    vi.advanceTimersByTime(90_000);
    expect(reporter.reportIfDue()).toBe(
      'Received 1 tool result since the last update. Work is continuing.',
    );
    expect(reporter.reportIfDue()).toBeNull();
    vi.advanceTimersByTime(90_000);
    expect(reporter.reportIfDue()).toBeNull();
  });

  it('resets the timer and activity count after a main-agent milestone', () => {
    const reporter = new ProgressReporter();
    reporter.noteToolCompletion({ kind: 'command', outcome: 'failed' });
    vi.advanceTimersByTime(80_000);
    reporter.noteSummary();
    reporter.noteToolCompletion({ kind: 'tool' });
    vi.advanceTimersByTime(20_000);
    expect(reporter.reportIfDue()).toBeNull();
    vi.advanceTimersByTime(70_000);
    expect(reporter.reportIfDue()).toBe(
      'Received 1 tool result since the last update. Work is continuing.',
    );
  });

  it.each([false, true])(
    'does not repeat a stale failure after success (already reported: %s)',
    (reported) => {
      const reporter = new ProgressReporter();
      reporter.noteToolCompletion({ kind: 'command', outcome: 'failed' });
      if (reported) {
        vi.advanceTimersByTime(90_000);
        expect(reporter.reportIfDue()).toContain('latest command reported an error');
      }
      reporter.noteToolCompletion({ kind: 'command', outcome: 'succeeded' });
      vi.advanceTimersByTime(90_000);
      const summary = reporter.reportIfDue();
      expect(summary).toContain(`Received ${reported ? 1 : 2} tool result`);
      expect(summary).toContain('latest command reported success');
      expect(summary).not.toMatch(/error|block|tests|resolved|finished/i);
    },
  );

  it('does not describe an earlier command when the latest result is another tool', () => {
    const reporter = new ProgressReporter();
    reporter.noteToolCompletion({ kind: 'command', outcome: 'failed' });
    reporter.noteToolCompletion({ kind: 'tool' });
    vi.advanceTimersByTime(90_000);
    expect(reporter.reportIfDue()).toBe(
      'Received 2 tool results since the last update. Work is continuing.',
    );
  });

  it('does not treat an unknown command status as success', () => {
    const reporter = new ProgressReporter();
    reporter.noteToolCompletion({ kind: 'command', outcome: 'unknown' });
    vi.advanceTimersByTime(90_000);
    expect(reporter.reportIfDue()).toContain('completion status is unknown');
  });

  it('starts each invocation without old session activity', () => {
    const reporter = new ProgressReporter();
    vi.advanceTimersByTime(90_000);
    expect(reporter.reportIfDue()).toBeNull();
    reporter.noteToolCompletion({ kind: 'tool' });
    expect(reporter.reportIfDue()).toContain('Received 1 tool result');
    const nextInvocation = new ProgressReporter();
    vi.advanceTimersByTime(90_000);
    expect(nextInvocation.reportIfDue()).toBeNull();
  });

  it('does not emit after cancellation', () => {
    const reporter = new ProgressReporter();
    reporter.noteToolCompletion({ kind: 'tool' });
    vi.advanceTimersByTime(90_000);
    const controller = new AbortController();
    controller.abort();
    expect(() => reporter.reportIfDue(controller.signal)).toThrow('cancelled');
  });

  it('reconstructs standalone updates as progress on reopen', () => {
    const reporter = new ProgressReporter();
    reporter.noteToolCompletion({ kind: 'command', outcome: 'succeeded' });
    vi.advanceTimersByTime(90_000);
    const summary = reporter.reportIfDue();
    const transcript = buildTranscript([
      { role: 'user', content: 'Fix the chart' },
      { role: 'assistant', content: `<progress_summary>${summary}</progress_summary>` },
    ]);
    expect(transcript[1].blocks).toEqual([
      expect.objectContaining({ kind: 'agentReasoning', text: summary }),
    ]);
  });
});
