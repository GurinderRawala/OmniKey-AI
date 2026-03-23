import fs from 'fs';
import { readConfig, getConfigPath, getConfigDir } from './utils';

const API_KEY_FIELDS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'SERPER_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'TAVILY_API_KEY',
];

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

export function showConfig() {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  if (!fs.existsSync(configPath)) {
    console.log('No configuration found. Run `omnikey onboard` to get started.');
    return;
  }

  const config = readConfig();
  const keys = Object.keys(config);

  if (keys.length === 0) {
    console.log('Configuration file exists but is empty.');
    return;
  }

  console.log(`Config file: ${configPath}\n`);
  console.log('Current configuration:');
  console.log('─'.repeat(50));

  for (const key of keys) {
    const raw = String(config[key]);
    const display = API_KEY_FIELDS.includes(key) ? maskSecret(raw) : raw;
    console.log(`  ${key}: ${display}`);
  }

  console.log('─'.repeat(50));
  console.log(`\nConfig directory: ${configDir}`);
}
