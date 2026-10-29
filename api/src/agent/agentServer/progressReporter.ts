import { throwIfTurnCancelled } from './turnCancellation';

const SILENCE_INTERVAL_MS = 90_000;

export type ToolCompletion =
  | { kind: 'command'; outcome: 'succeeded' | 'failed' | 'unknown' }
  | { kind: 'tool' };

/**
 * Shared across internal restarts. Record live execution metadata, not transcript
 * offsets or output excerpts: compaction can replace history and stdout can
 * contain source code, old failures, or instructions. Detailed milestone claims
 * belong to the main agent, which has the task context.
 */
export class ProgressReporter {
  private lastReportAt = Date.now();
  private completedCount = 0;
  private latest: ToolCompletion | undefined;

  noteToolCompletion(completion: ToolCompletion): void {
    this.completedCount++;
    this.latest = completion;
  }

  noteSummary(): void {
    this.lastReportAt = Date.now();
    this.completedCount = 0;
    this.latest = undefined;
  }

  reportIfDue(signal?: AbortSignal): string | null {
    throwIfTurnCancelled(signal);
    if (Date.now() - this.lastReportAt < SILENCE_INTERVAL_MS || !this.completedCount) return null;

    let status = '';
    if (this.latest?.kind === 'command') {
      switch (this.latest.outcome) {
        case 'succeeded':
          status = ' The latest command reported success.';
          break;
        case 'failed':
          status = ' The latest command reported an error.';
          break;
        case 'unknown':
          status = ' The latest command’s completion status is unknown.';
          break;
      }
    }
    // A command succeeding does not establish test coverage, task completion,
    // or resolution of earlier blockers. Never carry such claims forward.
    const summary = `Received ${this.completedCount} tool result${this.completedCount === 1 ? '' : 's'} since the last update.${status} Work is continuing.`;
    this.noteSummary();
    return summary;
  }
}
