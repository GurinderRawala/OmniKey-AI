import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const isWindows = process.platform === 'win32';

export function statusCmd() {
  // Read port from ~/.omnikey/config.json
  const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
  const configDir = path.join(homeDir, '.omnikey');
  const configPath = path.join(configDir, 'config.json');
  let port = 7071;
  if (fs.existsSync(configPath)) {
    try {
      const configVars = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (configVars.OMNIKEY_PORT) {
        port = Number(configVars.OMNIKEY_PORT);
      }
    } catch (e) {
      console.error('Failed to read config.json:', e);
    }
  }

  try {
    let output: string;
    if (isWindows) {
      output = execSync(`netstat -ano | findstr :${port}`).toString();
    } else {
      output = execSync(`lsof -i :${port}`).toString();
    }
    if (output.trim()) {
      console.log(`Processes using port ${port}:\n${output}`);
    } else {
      console.log(`No process is using port ${port}.`);
    }
  } catch {
    console.log(`No process is using port ${port}.`);
  }
}
