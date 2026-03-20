import { execSync } from 'child_process';
import { killPersistenceAgent } from './removeConfig';
import { isWindows, getPort } from './utils';

/**
 * Kill the Omnikey API backend daemon.
 * Reads the port from ~/.omnikey/config.json (falls back to 7071).
 * Removes the persistence agent, then kills any remaining process on the port.
 */
export function killDaemon() {
  const port = getPort();

  // 1. Remove/stop the persistence agent
  try {
    killPersistenceAgent();
    console.log('Persistence agent stopped (if it existed).');
  } catch (e) {
    console.warn('Failed to stop persistence agent:', e);
  }

  // 2. Find any remaining processes still using the port
  let pids: string[] = [];
  try {
    if (isWindows) {
      // netstat -ano lists PID in the last column; filter by :<port> with LISTENING or ESTABLISHED
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const seen = new Set<string>();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0' && !seen.has(pid)) {
          seen.add(pid);
          pids.push(pid);
        }
      }
    } else {
      pids = execSync(`lsof -i :${port} -t`).toString().split('\n').filter(Boolean);
    }
  } catch {
    pids = [];
  }

  if (pids.length === 0) {
    console.log(`No process found using port ${port}.`);
    return;
  }

  // 3. Kill each process
  for (const pid of pids) {
    try {
      if (isWindows) {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
      } else {
        process.kill(Number(pid), 'SIGTERM');
      }
      console.log(`Killed process with PID ${pid} using port ${port}.`);
    } catch (e) {
      console.error(`Failed to kill process ${pid}:`, e);
    }
  }
}
