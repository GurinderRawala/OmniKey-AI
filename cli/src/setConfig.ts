import { readConfig, getConfigPath, writeConfig } from './utils';

export function setConfig(key: string, value: string) {
  const configPath = getConfigPath();

  const config = readConfig();
  config[key] = value;
  writeConfig(config);
  console.log(`Set ${key} in ${configPath}`);
}
