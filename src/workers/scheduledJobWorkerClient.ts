import type { ManagedWorker } from './spawn';

let scheduledJobWorker: ManagedWorker | null = null;

/**
 * Register the scheduledJobWorker handle so HTTP routes can post messages to
 * it. Called once from `index.ts` after the worker is spawned.
 */
export function setScheduledJobWorker(worker: ManagedWorker | null): void {
  scheduledJobWorker = worker;
}

/**
 * Ask the scheduledJobWorker to execute a job immediately. Returns true if
 * the message was dispatched, false if no worker is currently running (e.g.
 * non-self-hosted deployments where the executor still runs in-process). The
 * caller is expected to fall back to an in-process `executeJob` when this
 * returns false.
 */
export function triggerJobInWorker(jobId: string): boolean {
  if (!scheduledJobWorker) return false;
  scheduledJobWorker.postMessage({ type: 'runJob', jobId });
  return true;
}
