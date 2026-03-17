import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

/**
 * Start the Omnikey API backend as a daemon on the specified port.
 * Also creates and registers a launchd agent for persistence on macOS.
 * @param port The port to run the backend on
 */
export function startDaemon(port: number = 7071) {
  // Only use ~/.omnikey/config.json for environment variables

  // Path to the backend entry point (now from backend-dist)
  const backendPath = path.resolve(__dirname, '../backend-dist/index.js');

  // Read and update environment variables from ~/.omnikey/config.json
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
  // Ensure both OMNIKEY_PORT and PORT are set for compatibility
  configVars.OMNIKEY_PORT = port;
  // Write the updated configVars back to config.json
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(configVars, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write updated config.json:', e);
  }

  // Create launchd agent for persistence
  const plistName = 'com.omnikey.daemon.plist';
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', plistName);
  const nodePath = process.execPath;
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
  <string>${path.join(configDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(configDir, 'daemon-error.log')}</string>
  <key>WorkingDirectory</key>
  <string>${configDir}</string>
</dict>
</plist>
`;
  // Write plist file
  try {
    const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.writeFileSync(plistPath, plistContent, 'utf-8');
    // Load the launch agent
    execSync(`launchctl unload "${plistPath}" || true`); // Unload if already loaded
    execSync(`launchctl load "${plistPath}"`);
    console.log(`Launch agent created and loaded: ${plistPath}`);
    console.log('Omnikey daemon will auto-restart and persist across reboots.');
  } catch (e) {
    console.error('Failed to create or load launch agent:', e);
  }

  // Also start the backend immediately for current session
  const logPath = path.join(configDir, 'daemon.log');
  const errorLogPath = path.join(configDir, 'daemon-error.log');
  // Clean (truncate) log files before starting new session
  try {
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(errorLogPath, '');
  } catch (e) {
    // Ignore errors if files don't exist yet
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
