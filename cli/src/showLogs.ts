import fs from 'fs';
import path from 'path';

/**
 * Show the logs of the running Omnikey daemon by printing the contents of the daemon log file.
 * Prints the last N lines (default 50) for convenience.
 */
export function showLogs(lines: number = 50) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
  const configDir = path.join(homeDir, '.omnikey');
  const logPath = path.join(configDir, 'daemon.log');
  const errorLogPath = path.join(configDir, 'daemon-error.log');

  let logLines: string[] = [];
  let errorLines: string[] = [];
  if (fs.existsSync(logPath)) {
    const logContent = fs.readFileSync(logPath, 'utf-8');
    logLines = logContent.split('\n');
  }
  if (fs.existsSync(errorLogPath)) {
    const errorContent = fs.readFileSync(errorLogPath, 'utf-8');
    errorLines = errorContent.split('\n');
  }

  if (logLines.length === 0 && errorLines.length === 0) {
    console.log('No daemon.log or daemon-error.log file found.');
    return;
  }

  const left = logLines.slice(-lines);
  const right = errorLines.slice(-lines);

  // Calculate column widths
  const leftWidth = Math.max(40, ...left.map((l) => l.length));
  const rightWidth = Math.max(40, ...right.map((l) => l.length));

  // Print header
  const leftHeader = 'Other Logs'.padEnd(leftWidth);
  const rightHeader = 'Errors'.padEnd(rightWidth);
  console.log(`${leftHeader} | ${rightHeader}`);
  console.log('-'.repeat(leftWidth) + '-+-' + '-'.repeat(rightWidth));

  // Print lines side by side
  for (let i = 0; i < lines; i++) {
    const l = left[i] !== undefined ? left[i] : '';
    const r = right[i] !== undefined ? right[i] : '';
    console.log(l.padEnd(leftWidth) + ' | ' + r.padEnd(rightWidth));
  }
}
