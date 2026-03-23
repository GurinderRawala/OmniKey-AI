import fs from 'fs';
import { readConfig, getConfigPath, getConfigDir } from './utils';

export function setConfig(key: string, value: string) {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config = readConfig();
  config[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`Set ${key} in ${configPath}`);
}
