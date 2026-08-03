import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const CONFIG_KEYS = [
  'AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'HOME',
  'IS_SELF_HOSTED',
  'NEMOTRON_API_KEY',
  'NVIDIA_API_KEY',
  'OMNIKEY_CONFIG_PATH',
  'OMNIKEY_PORT',
  'OPENAI_API_KEY',
  'OPEN_MODEL_API_KEY',
  'SQLITE_PATH',
  'USERPROFILE',
] as const;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  for (const key of CONFIG_KEYS) delete process.env[key];
}

function writeLocalConfig(homeDir: string, data: Record<string, unknown>): string {
  const configDir = path.join(homeDir, '.omnikey');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
  return configPath;
}

describe('config local file loading', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    resetEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-config-'));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads daemon configuration from ~/.omnikey/config.json when env vars are missing', async () => {
    process.env.HOME = tmpDir;
    writeLocalConfig(tmpDir, {
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'file-anthropic-key',
      IS_SELF_HOSTED: true,
      OMNIKEY_PORT: 7312,
      SQLITE_PATH: 'local.sqlite',
    });

    const { config } = await import('../config');

    expect(config.aiProvider).toBe('anthropic');
    expect(config.aiApiKey).toBe('file-anthropic-key');
    expect(config.sqlitePath).toBe(path.join(tmpDir, '.omnikey', 'local.sqlite'));
  });

  it('keeps explicit process env values ahead of config.json fallback values', async () => {
    const configPath = writeLocalConfig(tmpDir, {
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'file-openai-key',
      IS_SELF_HOSTED: true,
      OMNIKEY_PORT: 7312,
    });

    process.env.OMNIKEY_CONFIG_PATH = configPath;
    process.env.OPENAI_API_KEY = 'env-openai-key';

    const { config } = await import('../config');

    expect(config.aiProvider).toBe('openai');
    expect(config.aiApiKey).toBe('env-openai-key');
    expect(process.env.OPENAI_API_KEY).toBe('env-openai-key');
  });
});
