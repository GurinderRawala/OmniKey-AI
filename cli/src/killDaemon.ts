import { execSync } from 'child_process';

/**
 * Kill the Omnikey API backend daemon running on a given port (default 7071).
 * Looks for node processes running backend-dist/index.js on the specified port and kills them.
 * @param port The port to look for (default 7071)
 */
export function killDaemon(port: number = 7071) {
  try {
    // Find the PID(s) of node processes running backend-dist/index.js on the given port
    // macOS: lsof -i :PORT -t
    const pids = execSync(`lsof -i :${port} -t`).toString().split('\n').filter(Boolean);
    if (pids.length === 0) {
      console.log(`No daemon found running on port ${port}.`);
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        console.log(`Killed daemon process with PID ${pid} on port ${port}.`);
      } catch (e) {
        console.error(`Failed to kill process ${pid}:`, e);
      }
    }
  } catch (e) {
    console.log(`No daemon found running on port ${port}.`);
  }
}
