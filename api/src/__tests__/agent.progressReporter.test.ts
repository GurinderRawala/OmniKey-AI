import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete },
  getFixedHelperModel: () => 'summary-model',
}));
import { ProgressReporter } from '../agent/agentServer/progressReporter';
import { buildTranscript } from '../agent/agentServer/transcript';
import type { SessionState } from '../agent/types';
const log = { warn: vi.fn() } as any;
function session(): SessionState {
  return {
    subscription: {} as any,
    turns: 1,
    history: [
      { role: 'user', content: 'Fix the chart' },
      { role: 'tool', tool_name: 'shell_script', content: '79 tests passed.' },
    ],
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.complete.mockReset().mockResolvedValue({
    content: '{"summary":"The test run passed. Review is still pending."}',
    finish_reason: 'stop',
  });
});
afterEach(() => vi.useRealTimers());
describe('progress reporting during silent runs', () => {
  it('reports only after silence, using observed results, and records usage', async () => {
    const reporter = new ProgressReporter();
    const s = session();
    const usage = vi.fn();
    expect(await reporter.reportIfDue(s, log, usage)).toBeNull();
    await vi.advanceTimersByTimeAsync(90_000);
    const summary = await reporter.reportIfDue(s, log, usage);
    expect(summary).toContain('test run passed');
    expect(mocks.complete.mock.calls[0][1][1].content).toContain('79 tests passed.');
    expect(mocks.complete.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(await reporter.reportIfDue(s, log, usage)).toBeNull();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await reporter.reportIfDue(s, log, usage)).toBeNull(); // no new results
  });
  it('resets the silence timer when the main model supplies a summary', async () => {
    const reporter = new ProgressReporter();
    const s = session();
    await vi.advanceTimersByTimeAsync(80_000);
    reporter.noteSummary(1, 'Found the chart bug.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await reporter.reportIfDue(s, log, vi.fn())).toBeNull();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await reporter.reportIfDue(s, log, vi.fn())).toContain('test run passed');
    expect(mocks.complete.mock.calls[0][1][1].content).toContain('Found the chart bug.');
  });
  it.each(['unavailable', 'invalid', 'truncated'])(
    'continues with factual progress when the helper is %s',
    async (failure) => {
      const reporter = new ProgressReporter();
      if (failure === 'unavailable') mocks.complete.mockRejectedValue(new Error('offline'));
      else
        mocks.complete.mockResolvedValue({
          content: failure === 'invalid' ? 'bad json' : '{"summary":"Done"}',
          finish_reason: failure === 'truncated' ? 'length' : 'stop',
        });
      await vi.advanceTimersByTimeAsync(90_000);
      const summary = await reporter.reportIfDue(session(), log, vi.fn());
      expect(summary).toContain('Received 1 tool result');
      expect(summary).not.toContain('Done');
    },
  );
  it('bounds a hung helper and aborts its request', async () => {
    const reporter = new ProgressReporter();
    mocks.complete.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(90_000);
    const pending = reporter.reportIfDue(session(), log, vi.fn());
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toContain('task is still running');
    expect(mocks.complete.mock.calls[0][2].signal.aborted).toBe(true);
  });
  it('does not emit after user cancellation', async () => {
    const reporter = new ProgressReporter();
    const s = session();
    const controller = new AbortController();
    s.signal = controller.signal;
    mocks.complete.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(90_000);
    const pending = expect(reporter.reportIfDue(s, log, vi.fn())).rejects.toThrow('cancelled');
    controller.abort();
    await pending;
    expect(mocks.complete.mock.calls[0][2].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('redacts generated text and reconstructs standalone updates as progress on reopen', async () => {
    const reporter = new ProgressReporter();
    mocks.complete.mockResolvedValue({
      content: '{"summary":"<b>Tests passed</b>. api_key=hidden"}',
      finish_reason: 'stop',
    });
    await vi.advanceTimersByTimeAsync(90_000);
    const summary = await reporter.reportIfDue(session(), log, vi.fn());
    expect(summary).not.toContain('hidden');
    const transcript = buildTranscript([
      { role: 'user', content: 'Fix the chart' },
      { role: 'assistant', content: `<progress_summary>${summary}</progress_summary>` },
    ]);
    expect(transcript[1].blocks).toEqual([
      expect.objectContaining({ kind: 'agentReasoning', text: summary }),
    ]);
  });
  it('excludes old session results and keeps its boundary across internal restarts', async () => {
    const reporter = new ProgressReporter();
    const s = session();
    reporter.begin(s.history.length);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await reporter.reportIfDue(s, log, vi.fn())).toBeNull();
    s.history.push({ role: 'tool', content: 'New task: compile succeeded.' });
    reporter.begin(s.history.length); // restart must not reset the initial boundary
    await reporter.reportIfDue(s, log, vi.fn());
    const input = mocks.complete.mock.calls[0][1][1].content;
    expect(input).toContain('compile succeeded');
    expect(input).not.toContain('79 tests passed');
  });
  it.each([
    'Fetching active-user rows takes 5.6 seconds.',
    'Fetching active-user rows takes five point six seconds.',
    'The active-user query returned ten rows.',
    'The active-user query is twice as fast: ５０ percent faster.',
  ])('rejects quantitative fallback claims: %s', async (claim) => {
    const reporter = new ProgressReporter();
    const s = session();
    s.history.push({
      role: 'tool',
      content: JSON.stringify([
        { panelId: 'tool-findings', responseStart: 5616, rows: 0 },
        { panelId: 'active-users', responseStart: 11808, rows: 10 },
      ]),
    });
    mocks.complete.mockResolvedValue({
      content: JSON.stringify({ summary: claim }),
      finish_reason: 'stop',
    });
    await vi.advanceTimersByTimeAsync(90_000);
    const summary = await reporter.reportIfDue(s, log, vi.fn());
    expect(summary).toBe(
      'Received 2 tool results since the last update. The task is still running; a final outcome has not been reported yet.',
    );
  });

  it('keeps source excerpts contiguous and explicitly marks truncation', async () => {
    const reporter = new ProgressReporter();
    const s = session();
    s.history.push({
      role: 'tool',
      tool_name: 'shell_script',
      content:
        'panelId: tool-findings\n' +
        'context '.repeat(300) +
        'panelId: active-users; responseStart: 11808',
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await reporter.reportIfDue(s, log, vi.fn());
    const input = JSON.parse(mocks.complete.mock.calls[0][1][1].content);
    expect(input.results[1].truncated).toBe(true);
    expect(input.results[1].result).toBe(s.history.at(-1)!.content.slice(0, 1500));
    expect(input.results[1].result).not.toContain('11808');
    expect(input.results[0].truncated).toBe(false);
  });

  it('still permits grounded qualitative blockers', async () => {
    const reporter = new ProgressReporter();
    const s = session();
    s.history.push({
      role: 'tool',
      content: 'COMMAND ERROR: gcloud credentials expired; reauthentication required.',
    });
    const text =
      'Production profiling is blocked by expired cloud credentials. Source inspection is continuing.';
    mocks.complete.mockResolvedValue({
      content: JSON.stringify({ summary: text }),
      finish_reason: 'stop',
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await reporter.reportIfDue(s, log, vi.fn())).toBe(text);
  });
});
