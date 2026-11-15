import { execFileSync } from 'child_process';

/** launchd may acknowledge unload before the previous job has fully exited.
 * Retry its transient EIO response instead of leaving restart with no daemon.
 */
export async function loadLaunchAgent(plistPath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      execFileSync('/bin/launchctl', ['load', plistPath], { stdio: 'pipe' });
      return;
    } catch (error) {
      const failure = error as { stderr?: Buffer; message?: string };
      const detail = failure.stderr?.toString() || failure.message || '';
      if (
        !/(?:Load|Bootstrap) failed: 5: Input\/output error/i.test(detail) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}
