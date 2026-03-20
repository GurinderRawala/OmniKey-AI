import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { isWindows, getHomeDir, getConfigDir, readConfig } from './utils';

export function killLaunchdAgent() {
  const plistName = 'com.omnikey.daemon.plist';
  const plistPath = path.join(getHomeDir(), 'Library', 'LaunchAgents', plistName);
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}"`);
      fs.rmSync(plistPath);
      console.log(`Removed launchd agent: ${plistPath}`);
    } catch (e) {
      console.error(`Failed to remove launchd agent: ${e}`);
    }
  } else {
    console.log(`Launchd agent does not exist: ${plistPath}`);
  }
}

export function killWindowsTask() {
  const taskName = 'OmnikeyDaemon';
  try {
    execSync(`schtasks /end /tn "${taskName}"`, { stdio: 'pipe' });
  } catch {
    // Task may not be running — that's fine
  }
  try {
    execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' });
    console.log(`Removed Windows Task Scheduler task: ${taskName}`);
  } catch {
    console.log(`Windows Task Scheduler task does not exist: ${taskName}`);
  }

  // Also remove the wrapper script
  const wrapperPath = path.join(getConfigDir(), 'start-daemon.cmd');
  if (fs.existsSync(wrapperPath)) {
    try {
      fs.rmSync(wrapperPath);
    } catch {
      // Ignore
    }
  }
}

/**
 * Kill the platform-appropriate persistence agent (launchd on macOS, Task Scheduler on Windows).
 */
export function killPersistenceAgent() {
  if (isWindows) {
    killWindowsTask();
  } else {
    killLaunchdAgent();
  }
}

/**
 * Removes the ~/.omnikey config directory and the SQLite database file specified in config.json.
 */
export function removeConfigAndDb() {
  const homeDir = getHomeDir();
  const configDir = getConfigDir();
  const configData = readConfig();

  let sqlitePath = path.join(homeDir, 'omnikey-selfhosted.sqlite');
  if (configData.SQLITE_PATH) {
    sqlitePath = path.isAbsolute(configData.SQLITE_PATH)
      ? configData.SQLITE_PATH
      : path.join(homeDir, configData.SQLITE_PATH);
  }

  // Remove platform-appropriate persistence agent
  killPersistenceAgent();

  // Remove SQLite database
  if (fs.existsSync(sqlitePath)) {
    try {
      fs.rmSync(sqlitePath);
      console.log(`Removed SQLite database: ${sqlitePath}`);
    } catch (e) {
      console.error(`Failed to remove SQLite database: ${e}`);
    }
  } else {
    console.log(`SQLite database does not exist: ${sqlitePath}`);
  }

  // Remove .omnikey directory
  if (fs.existsSync(configDir)) {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
      console.log(`Removed config directory: ${configDir}`);
    } catch (e) {
      console.error(`Failed to remove config directory: ${e}`);
    }
  } else {
    console.log(`Config directory does not exist: ${configDir}`);
  }
}
