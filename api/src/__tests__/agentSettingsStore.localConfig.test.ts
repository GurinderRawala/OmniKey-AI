import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  config: {
    browserAccessEnabled: false,
    browserDebugExecutable: undefined,
    terminalAccess: 'full',
    usageRecordingEnabled: true,
    webSearchEnabled: true,
  },
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../models/agentSettings', () => ({
  AgentSettings: {
    findByPk: vi.fn(),
    findOrCreate: vi.fn(),
    update: vi.fn(),
  },
}));

function writeConfig(configPath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

describe('agentSettingsStore local config migration input', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-agent-settings-config-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads legacy settings from OMNIKEY_CONFIG_PATH instead of the default home config', async () => {
    const customConfigPath = path.join(tmpDir, 'daemon', 'config.json');
    const defaultConfigPath = path.join(tmpDir, 'home', '.omnikey', 'config.json');
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.USERPROFILE = path.join(tmpDir, 'profile');
    process.env.OMNIKEY_CONFIG_PATH = customConfigPath;

    writeConfig(customConfigPath, {
      ANTHROPIC_MODEL: 'claude-custom',
      TERMINAL_ACCESS: 'limited',
    });
    writeConfig(defaultConfigPath, {
      OPENAI_MODEL: 'gpt-from-default-file',
      TERMINAL_ACCESS: 'full',
    });

    const { readLocalConfigFile } = await import('../agentSettingsStore');
    const cfg = readLocalConfigFile();

    expect(cfg).toEqual(
      expect.objectContaining({
        ANTHROPIC_MODEL: 'claude-custom',
        TERMINAL_ACCESS: 'limited',
      }),
    );
    expect(cfg.OPENAI_MODEL).toBeUndefined();
  });
});
