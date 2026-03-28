import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
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
  const serviceName = 'OmnikeyDaemon';

  // Try NSSM first (current implementation)
  let nssmPath: string | null = null;
  try {
    nssmPath = execSync('where nssm', { stdio: 'pipe' }).toString().trim().split('\n')[0].trim();
  } catch {
    /* NSSM not installed */
  }

  if (nssmPath) {
    try {
      execFileSync(nssmPath, ['stop', serviceName], { stdio: 'pipe' });
    } catch {
      /* not running */
    }
    try {
      execFileSync(nssmPath, ['remove', serviceName, 'confirm'], { stdio: 'pipe' });
      console.log(`Removed NSSM service: ${serviceName}`);
    } catch {
      console.log(`NSSM service does not exist: ${serviceName}`);
    }
  } else {
    // Fallback: remove legacy Task Scheduler task from previous installs
    try {
      execSync(`schtasks /end /tn "${serviceName}"`, { stdio: 'pipe' });
    } catch {
      /* not running */
    }
    try {
      execSync(`schtasks /delete /tn "${serviceName}" /f`, { stdio: 'pipe' });
      console.log(`Removed Windows Task Scheduler task: ${serviceName}`);
    } catch {
      console.log(`Windows Task Scheduler task does not exist: ${serviceName}`);
    }
  }

  // Remove legacy wrapper script if present
  const wrapperPath = path.join(getConfigDir(), 'start-daemon.cmd');
  if (fs.existsSync(wrapperPath)) {
    try {
      fs.rmSync(wrapperPath);
    } catch {
      /* ignore */
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

  // Remove all files/folders inside .omnikey except the SQLite database
  if (fs.existsSync(configDir)) {
    try {
      const entries = fs.readdirSync(configDir);
      for (const entry of entries) {
        if (entry.endsWith('.sqlite')) {
          continue;
        }
        const entryPath = path.join(configDir, entry);
        fs.rmSync(entryPath, { recursive: true, force: true });
        console.log(`Removed: ${entryPath}`);
      }
      console.log(`Cleared config directory (SQLite preserved): ${configDir}`);
    } catch (e) {
      console.error(`Failed to clear config directory: ${e}`);
    }
  } else {
    console.log(`Config directory does not exist: ${configDir}`);
  }
}
