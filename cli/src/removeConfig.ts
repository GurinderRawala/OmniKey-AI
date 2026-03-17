import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export function killLaunchdAgent() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const plistName = 'com.omnikey.daemon.plist';
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', plistName);
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

/**
 * Removes the ~/.omnikey config directory and the SQLite database file specified in config.json.
 */
export function removeConfigAndDb() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configDir = path.join(homeDir, '.omnikey');
  const configPath = path.join(configDir, 'config.json');
  let sqlitePath = path.join(homeDir, 'omnikey-selfhosted.sqlite');

  // Try to read SQLITE_PATH from config.json
  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (configData.SQLITE_PATH) {
        sqlitePath = path.isAbsolute(configData.SQLITE_PATH)
          ? configData.SQLITE_PATH
          : path.join(homeDir, configData.SQLITE_PATH);
      }
    } catch (e) {
      console.error(`Failed to read config.json: ${e}`);
    }
  }

  // Remove launchd agent if exists (macOS)
  killLaunchdAgent();

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
