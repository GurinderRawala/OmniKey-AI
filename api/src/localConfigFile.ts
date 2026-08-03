import fs from 'fs';
import os from 'os';
import path from 'path';

export function getLocalConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return process.env.OMNIKEY_CONFIG_PATH || path.join(home, '.omnikey', 'config.json');
}

export function writeLocalConfigJson(data: Record<string, any>): void {
  const configPath = getLocalConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  fs.chmodSync(configPath, 0o600);
}
