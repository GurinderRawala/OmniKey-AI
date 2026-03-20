import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

const isWindows = process.platform === 'win32';

/**
 * Start the Omnikey API backend as a daemon on the specified port.
 * On macOS: creates and registers a launchd agent for persistence.
 * On Windows: creates a wrapper script and registers a Windows Task Scheduler task.
 * @param port The port to run the backend on
 */
export function startDaemon(port: number = 7071) {
  const backendPath = path.resolve(__dirname, '../backend-dist/index.js');

  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configDir = path.join(homeDir, '.omnikey');
  const configPath = path.join(configDir, 'config.json');
  let configVars: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      configVars = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse config.json:', e);
    }
  }
  configVars.OMNIKEY_PORT = port;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(configVars, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write updated config.json:', e);
  }

  const nodePath = process.execPath;
  const logPath = path.join(configDir, 'daemon.log');
  const errorLogPath = path.join(configDir, 'daemon-error.log');

  if (isWindows) {
    startDaemonWindows({ port, configDir, configVars, nodePath, backendPath, logPath, errorLogPath });
  } else {
    startDaemonMacOS({ port, configDir, configVars, nodePath, backendPath, logPath, errorLogPath });
  }
}

interface DaemonOptions {
  port: number;
  configDir: string;
  configVars: Record<string, any>;
  nodePath: string;
  backendPath: string;
  logPath: string;
  errorLogPath: string;
}

function startDaemonWindows(opts: DaemonOptions) {
  const { port, configDir, configVars, nodePath, backendPath, logPath, errorLogPath } = opts;

  // Write a wrapper .cmd script that sets env vars and launches the backend
  const wrapperPath = path.join(configDir, 'start-daemon.cmd');
  const envSetLines = Object.entries({ ...configVars, OMNIKEY_PORT: String(port) })
    .map(([k, v]) => `set "${k}=${v}"`)
    .join('\r\n');
  const wrapperContent = [
    '@echo off',
    envSetLines,
    `"${nodePath}" "${backendPath}" >> "${logPath}" 2>> "${errorLogPath}"`,
    '',
  ].join('\r\n');

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8');
  } catch (e) {
    console.error('Failed to write start-daemon.cmd:', e);
    return;
  }

  // Register with Windows Task Scheduler so the daemon persists across reboots
  const taskName = 'OmnikeyDaemon';
  try {
    // Delete existing task silently before creating a fresh one
    execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' });
  } catch {
    // Task may not exist — that's fine
  }
  try {
    execSync(
      `schtasks /create /tn "${taskName}" /tr "cmd /c \\"${wrapperPath}\\"" /sc ONLOGON /f`,
      { stdio: 'pipe' },
    );
    console.log(`Windows Task Scheduler task created: ${taskName}`);
    console.log('Omnikey daemon will auto-start on next logon.');
  } catch (e) {
    console.error('Failed to create Windows Task Scheduler task:', e);
  }

  // Also start the backend immediately for the current session
  try {
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(errorLogPath, '');
  } catch {
    // Ignore if files don't exist yet
  }
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(errorLogPath, 'a');
  const child = spawn(nodePath, [backendPath], {
    env: { ...process.env, ...configVars, OMNIKEY_PORT: String(port) },
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  console.log(`Omnikey API backend started as a daemon on port ${port}. PID: ${child.pid}`);
}

function startDaemonMacOS(opts: DaemonOptions) {
  const { port, configDir, configVars, nodePath, backendPath, logPath, errorLogPath } = opts;
  const homeDir = process.env.HOME || os.homedir();

  const plistName = 'com.omnikey.daemon.plist';
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', plistName);
  const envVars = Object.entries({ ...configVars, OMNIKEY_PORT: String(port) })
    .map(([k, v]) => `<key>${k}</key><string>${v}</string>`)
    .join('\n');
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.omnikey.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${backendPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    ${envVars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errorLogPath}</string>
  <key>WorkingDirectory</key>
  <string>${configDir}</string>
</dict>
</plist>
`;
  try {
    const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.writeFileSync(plistPath, plistContent, 'utf-8');
    execSync(`launchctl unload "${plistPath}" || true`);
    execSync(`launchctl load "${plistPath}"`);
    console.log(`Launch agent created and loaded: ${plistPath}`);
    console.log('Omnikey daemon will auto-restart and persist across reboots.');
  } catch (e) {
    console.error('Failed to create or load launch agent:', e);
  }

  try {
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(errorLogPath, '');
  } catch {
    // Ignore
  }
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(errorLogPath, 'a');
  const child = spawn('node', [backendPath], {
    env: { ...configVars, OMNIKEY_PORT: String(port) },
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  console.log(`Omnikey API backend started as a daemon on port ${port}. PID: ${child.pid}`);
}
