/** Stop at async boundaries without turning a user cancellation into an LLM failure. */
export function throwIfTurnCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Agent turn cancelled');
}
