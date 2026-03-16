import fs from 'fs';
import path from 'path';

/**
 * Removes the ~/.omnikey config directory and the default SQLite database file in the user's home directory.
 */
export function removeConfigAndDb() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
  const configDir = path.join(homeDir, '.omnikey');
  const sqlitePath = path.join(homeDir, 'omnikey-selfhosted.sqlite');

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
}
