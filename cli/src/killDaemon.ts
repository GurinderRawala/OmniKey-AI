import { execSync } from 'child_process';
import { killLaunchdAgent } from './removeConfig';

/**
 * Kill the Omnikey API backend daemon running on a given port (default 7071).
 * Looks for node processes running backend-dist/index.js on the specified port and kills them.
 * @param port The port to look for (default 7071)
 */
export function killDaemon(port: number = 7071) {
  // 1. Unload/kill the launchd agent first
  try {
    killLaunchdAgent();
    console.log('Launchd agent unloaded (if it existed).');
  } catch (e) {
    console.warn('Failed to unload launchd agent or agent did not exist:', e);
  }

  // 2. Check if the port is still in use
  let pids: string[] = [];
  try {
    pids = execSync(`lsof -i :${port} -t`).toString().split('\n').filter(Boolean);
  } catch (e) {
    // lsof returns non-zero exit code if nothing is using the port
    pids = [];
  }

  if (pids.length === 0) {
    console.log(`No process found using port ${port} after unloading launchd agent.`);
    return;
  }

  // 3. If the port is still occupied, kill the process using the port
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`Killed process with PID ${pid} using port ${port}.`);
    } catch (e) {
      console.error(`Failed to kill process ${pid}:`, e);
    }
  }
}
