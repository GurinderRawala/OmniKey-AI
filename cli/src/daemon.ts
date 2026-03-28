import path from 'path';
import fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import inquirer from 'inquirer';
import {
  isWindows,
  getHomeDir,
  getConfigDir,
  getConfigPath,
  readConfig,
  initLogFiles,
} from './utils';

/**
 * Start the Omnikey API backend as a daemon on the specified port.
 * On macOS: creates and registers a launchd agent for persistence.
 * On Windows: installs an NSSM Windows service for boot-time persistence.
 * @param port The port to run the backend on
 */
export async function startDaemon(port: number = 7071) {
  const backendPath = path.resolve(__dirname, '../backend-dist/index.js');

  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const configVars = readConfig();
  configVars.OMNIKEY_PORT = port;
  configVars.TERMINAL_PLATFORM = isWindows ? 'windows' : 'macos';

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
    await startDaemonWindows({
      port,
      configDir,
      configVars,
      nodePath,
      backendPath,
      logPath,
      errorLogPath,
    });
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

function resolveNssm(): string | null {
  try {
    return execSync('where nssm', { stdio: 'pipe' }).toString().trim().split('\n')[0].trim();
  } catch {
    return null;
  }
}

async function startDaemonWindows(opts: DaemonOptions) {
  const { port, configDir, configVars, nodePath, backendPath, logPath, errorLogPath } = opts;
  const serviceName = 'OmnikeyDaemon';

  let nssmPath = resolveNssm();
  if (!nssmPath) {
    const { install } = await inquirer.prompt<{ install: boolean }>([
      {
        type: 'confirm',
        name: 'install',
        message: 'NSSM is required but not found. Install it now via winget?',
        default: true,
      },
    ]);

    if (!install) {
      console.log(
        'Aborted. Install NSSM manually and re-run in an elevated (Administrator) terminal.',
      );
      return;
    }

    console.log('Installing NSSM via winget...');
    try {
      execSync('winget install nssm --accept-package-agreements --accept-source-agreements', {
        stdio: 'inherit',
      });
    } catch (e) {
      console.error('winget install failed:', (e as any)?.message ?? e);
      console.log('Try manually: scoop install nssm  or  choco install nssm');
      return;
    }

    // winget updates the machine PATH in the registry but the current process
    // won't see it — spawn a fresh cmd to resolve the new location.
    try {
      nssmPath = execSync('cmd /c where nssm', { stdio: 'pipe' })
        .toString()
        .trim()
        .split('\n')[0]
        .trim();
    } catch {
      nssmPath = null;
    }

    if (!nssmPath) {
      console.log('NSSM installed successfully.');
      console.log('Please open a new elevated (Administrator) terminal and re-run this command.');
      return;
    }
  }

  initLogFiles(logPath, errorLogPath);

  // Remove any existing service (stop first, then remove)
  try {
    execFileSync(nssmPath, ['stop', serviceName], { stdio: 'pipe' });
  } catch {
    /* not running */
  }
  try {
    execFileSync(nssmPath, ['remove', serviceName, 'confirm'], { stdio: 'pipe' });
  } catch {
    /* didn't exist */
  }

  // NSSM services run as LocalSystem; pass USERPROFILE so the backend's
  // getHomeDir() resolves to the correct user config directory.
  const env: Record<string, string> = {
    ...configVars,
    OMNIKEY_PORT: String(port),
    USERPROFILE: process.env.USERPROFILE || configDir.replace(/[/\\]\.omnikey$/, ''),
    HOME: process.env.USERPROFILE || configDir.replace(/[/\\]\.omnikey$/, ''),
  };

  try {
    // Install: nssm install <name> <application> [args...]
    execFileSync(nssmPath, ['install', serviceName, nodePath, backendPath], { stdio: 'pipe' });

    execFileSync(nssmPath, ['set', serviceName, 'AppDirectory', configDir], { stdio: 'pipe' });

    // Pass all env vars in a single call (replaces the entire AppEnvironmentExtra key)
    const envEntries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    execFileSync(nssmPath, ['set', serviceName, 'AppEnvironmentExtra', ...envEntries], {
      stdio: 'pipe',
    });

    execFileSync(nssmPath, ['set', serviceName, 'AppStdout', logPath], { stdio: 'pipe' });
    execFileSync(nssmPath, ['set', serviceName, 'AppStderr', errorLogPath], { stdio: 'pipe' });
    execFileSync(nssmPath, ['set', serviceName, 'AppRotateFiles', '1'], { stdio: 'pipe' });

    // Restart automatically after a 3-second delay on any exit
    execFileSync(nssmPath, ['set', serviceName, 'AppExit', 'Default', 'Restart'], {
      stdio: 'pipe',
    });
    execFileSync(nssmPath, ['set', serviceName, 'AppRestartDelay', '3000'], { stdio: 'pipe' });

    // Start automatically at boot (no login required)
    execFileSync(nssmPath, ['set', serviceName, 'Start', 'SERVICE_AUTO_START'], { stdio: 'pipe' });

    execFileSync(nssmPath, ['set', serviceName, 'DisplayName', 'Omnikey API Backend'], {
      stdio: 'pipe',
    });
    execFileSync(nssmPath, ['set', serviceName, 'Description', 'Omnikey API Backend Daemon'], {
      stdio: 'pipe',
    });

    execFileSync(nssmPath, ['start', serviceName], { stdio: 'pipe' });

    console.log(`NSSM service installed and started: ${serviceName}`);
    console.log('Omnikey daemon runs on boot, without login, and auto-restarts on crash.');
    console.log(`Logs: ${logPath}`);
    console.log(`      ${errorLogPath}`);
  } catch (e: any) {
    const msg: string = e?.stderr?.toString() || e?.message || String(e);
    if (msg.toLowerCase().includes('access') || msg.toLowerCase().includes('privilege')) {
      console.error('Failed to install NSSM service: administrator privileges are required.');
      console.error('Re-run this command in an elevated (Administrator) terminal.');
    } else {
      console.error('Failed to install NSSM service:', msg);
    }
  }
}

function startDaemonMacOS(opts: DaemonOptions) {
  const { port, configDir, configVars, nodePath, backendPath, logPath, errorLogPath } = opts;
  const homeDir = getHomeDir();

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
    initLogFiles(logPath, errorLogPath);
    execSync(`launchctl unload "${plistPath}" || true`);
    execSync(`launchctl load "${plistPath}"`);
    console.log(`Launch agent created and loaded: ${plistPath}`);
    console.log('Omnikey daemon will auto-restart and persist across reboots.');
    // launchd starts the process via RunAtLoad — no manual spawn needed here.
    // Spawning a second process would race to bind the same port, causing the
    // loser to crash and launchd's KeepAlive to restart it in a ~10s loop.
  } catch (e) {
    console.error('Failed to create or load launch agent:', e);
  }
}
