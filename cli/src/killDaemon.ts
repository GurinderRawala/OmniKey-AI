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

  // 2. Find the SERVER process listening on the port.
  //
  // We must only target the process that is LISTENING on the port — i.e. the
  // daemon itself. Earlier this matched every line containing `:<port>`, which
  // also caught ESTABLISHED *client* connections to the daemon (the desktop
  // app's WebSocket, the Telegram bot, the CLI). Their PID is the client, so
  // `taskkill /F` would kill the OmniKey app whenever a provider/settings
  // change triggered `restart-daemon`. Restrict to listeners on the LOCAL
  // address so only the server is killed.
  let pids: string[] = [];
  try {
    if (isWindows) {
      // netstat columns: Proto | Local Address | Foreign Address | State | PID.
      // Keep only TCP rows in the LISTENING state whose LOCAL address ends with
      // :<port> (e.g. 0.0.0.0:7071, 127.0.0.1:7071, [::]:7071).
      const output = execSync(`netstat -ano -p TCP | findstr LISTENING`).toString();
      const seen = new Set<string>();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = parts[1];
        const pid = parts[parts.length - 1];
        if (!localAddress.endsWith(`:${port}`)) continue;
        if (pid && /^\d+$/.test(pid) && pid !== '0' && !seen.has(pid)) {
          seen.add(pid);
          pids.push(pid);
        }
      }
    } else {
      // -sTCP:LISTEN restricts to the listening socket so client connections to
      // the port (the app, telegram bot) are never returned.
      pids = execSync(`lsof -i :${port} -sTCP:LISTEN -t`).toString().split('\n').filter(Boolean);
    }
  } catch {
    pids = [];
  }

  if (pids.length === 0) {
    console.log(`No process is running on port ${port}.`);
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
