import fs from 'fs';
import path from 'path';
import { getConfigDir } from './utils';

/**
 * Show the logs of the running Omnikey daemon by printing the contents of the daemon log file.
 * Prints the last N lines (default 50) for convenience.
 * If errorsOnly is true, shows daemon-error.log instead.
 */
export function showLogs(lines: number = 50, errorsOnly: boolean = false) {
  const logPath = path.join(getConfigDir(), errorsOnly ? 'daemon-error.log' : 'daemon.log');

  if (!fs.existsSync(logPath)) {
    console.log(errorsOnly ? 'No error logs found.' : 'No daemon logs found.');
    return;
  }

  const logContent = fs.readFileSync(logPath, 'utf-8');
  const logLines = logContent.split('\n');
  const lastLines = logLines.slice(-lines);
  if (errorsOnly) {
    console.log('--- Error Logs ---');
  } else {
    console.log('--- Daemon Logs ---');
  }
  lastLines.forEach((line) => console.log(line));
}
