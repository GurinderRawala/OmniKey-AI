import os from 'os';
import path from 'path';
import fs from 'fs';

export const isWindows = process.platform === 'win32';

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function getConfigDir(): string {
  return path.join(getHomeDir(), '.omnikey');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function readConfig(): Record<string, any> {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // fall through to empty config
    }
  }
  return {};
}

export function getPort(): number {
  const config = readConfig();
  return config.OMNIKEY_PORT ? Number(config.OMNIKEY_PORT) : 7071;
}

export function initLogFiles(logPath: string, errorLogPath: string): { out: number; err: number } {
  try {
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(errorLogPath, '');
  } catch {
    // Ignore if files don't exist yet
  }
  return {
    out: fs.openSync(logPath, 'a'),
    err: fs.openSync(errorLogPath, 'a'),
  };
}
