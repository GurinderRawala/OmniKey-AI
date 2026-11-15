import { activeSessions } from './runtimeState';

/** Called after closing sockets, whose close handlers cancel their turns.
 * Let those turns finish persisting cancellation checkpoints before exiting.
 */
export async function waitForAgentCheckpoints(timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (activeSessions.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return activeSessions.size === 0;
}
