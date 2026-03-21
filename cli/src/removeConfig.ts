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
 * Removes the ~/.omnikey config directory and optionally the SQLite database file.
 * @param includeDb - When true, also removes the SQLite database file.
 */
export function removeConfigAndDb(includeDb = false) {
  const homeDir = getHomeDir();
  const configDir = getConfigDir();
  const configData = readConfig();

  // Remove platform-appropriate persistence agent
  killPersistenceAgent();

  // Remove SQLite database only when --db flag is passed
  if (includeDb) {
    let sqlitePath = path.join(homeDir, 'omnikey-selfhosted.sqlite');
    if (configData.SQLITE_PATH) {
      sqlitePath = path.isAbsolute(configData.SQLITE_PATH)
        ? configData.SQLITE_PATH
        : path.join(homeDir, configData.SQLITE_PATH);
    }

    if (fs.existsSync(sqlitePath)) {
      const maxAttempts = isWindows ? 5 : 1;
      let removed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          fs.rmSync(sqlitePath);
          console.log(`Removed SQLite database: ${sqlitePath}`);
          removed = true;
          break;
        } catch (e: any) {
          if (
            isWindows &&
            attempt < maxAttempts &&
            (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')
          ) {
            // File may still be locked by the daemon — wait ~1s and retry
            execSync(`ping -n 2 127.0.0.1 > nul`, { stdio: 'pipe' });
          } else {
            console.error(`Failed to remove SQLite database: ${e}`);
            break;
          }
        }
      }
      if (!removed && isWindows) {
        console.error(
          `Failed to remove SQLite database after ${maxAttempts} attempts: ${sqlitePath}`,
        );
      }
    } else {
      console.log(`SQLite database does not exist: ${sqlitePath}`);
    }
  } else {
    console.log('Skipping SQLite database removal (use --db to remove it).');
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
