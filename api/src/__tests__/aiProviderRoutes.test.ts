import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    log,
    spawn: vi.fn((_command: string, _args: string[]) => ({ unref: vi.fn() })),
    settings: {
      id: 'default',
      terminalAccess: 'full',
      webSearchEnabled: true,
      usageRecordingEnabled: true,
      browserAccessEnabled: false,
      openaiModel: 'gpt-5.5',
      anthropicModel: 'claude-opus-4-5',
      geminiModel: 'gemini-2.5-pro',
      nemotronModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    },
    updateAgentSettings: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('../authMiddleware', () => ({
  authMiddleware: vi.fn((_req, res, next) => {
    res.locals.logger = mocks.log;
    next();
  }),
}));

vi.mock('../config', () => ({
  config: {
    aiProvider: 'openai',
    nemotronResponsesApiEnabled: false,
    port: 7331,
  },
}));

vi.mock('../logger', () => ({
  logger: mocks.log,
}));

function modelFieldForProvider(provider: string): string {
  return `${provider === 'nemotron' ? 'nemotron' : provider}Model`;
}

function selectedAgentModelForProvider(settings: Record<string, string>, provider: string): string {
  return settings[modelFieldForProvider(provider)];
}

function defaultConfigPath(homeDir: string): string {
  return path.join(homeDir, '.omnikey', 'config.json');
}

function activeConfigPath(): string {
  return (
    process.env.OMNIKEY_CONFIG_PATH ||
    defaultConfigPath(process.env.HOME || process.env.USERPROFILE || os.homedir())
  );
}

function writeConfigAt(configPath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  fs.chmodSync(configPath, 0o600);
}

function writeLocalConfigFile(data: Record<string, unknown>): void {
  writeConfigAt(activeConfigPath(), data);
}

vi.mock('../agentSettingsStore', () => ({
  agentModelOptionsForProvider: vi.fn((provider: string) =>
    provider === 'openai' ? [{ id: 'gpt-5.5', label: 'GPT 5.5' }] : [],
  ),
  getAgentSettings: vi.fn(async () => mocks.settings),
  modelFieldForProvider: vi.fn(modelFieldForProvider),
  selectedAgentModelForProvider: vi.fn(selectedAgentModelForProvider),
  updateAgentSettings: mocks.updateAgentSettings,
  writeLocalConfigFile,
}));

import { aiProviderRouter } from '../aiProviderRoutes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', aiProviderRouter());
  return app;
}

function readConfigFile(configPath = activeConfigPath()): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

describe('aiProviderRouter', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalOmnikeyConfigPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-provider-route-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalOmnikeyConfigPath = process.env.OMNIKEY_CONFIG_PATH;
    process.env.HOME = tmpDir;
    delete process.env.USERPROFILE;
    delete process.env.OMNIKEY_CONFIG_PATH;
    mocks.settings.openaiModel = 'gpt-5.5';
    mocks.settings.anthropicModel = 'claude-opus-4-5';
    mocks.updateAgentSettings.mockImplementation(async (patch: Record<string, string>) => {
      Object.assign(mocks.settings, patch);
      return mocks.settings;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOmnikeyConfigPath === undefined) delete process.env.OMNIKEY_CONFIG_PATH;
    else process.env.OMNIKEY_CONFIG_PATH = originalOmnikeyConfigPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists active provider key updates, masks secrets, and schedules a restart', async () => {
    writeLocalConfigFile({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'old-openai-key',
    });

    const res = await request(makeApp())
      .put('/api/providers/openai')
      .send({ apiKey: 'sk-new-openai-key-1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        provider: 'openai',
        isConfigured: true,
        apiKeyMasked: 'sk-••••••••1234',
        restartScheduled: true,
      }),
    );

    expect(readConfigFile()).toEqual(
      expect.objectContaining({
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-new-openai-key-1234',
      }),
    );

    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['restart-daemon', '--port', '7331']),
    );
  });

  it('clears open-model legacy aliases and null base-url aliases on update', async () => {
    writeLocalConfigFile({
      AI_PROVIDER: 'nemotron',
      NEMOTRON_API_KEY: 'legacy-key',
      NVIDIA_API_KEY: 'nvidia-key',
      NEMOTRON_BASE_URL: 'https://legacy.example/v1',
      OPEN_MODEL_BASE_URL: 'https://old.example/v1',
      NEMOTRON_RESPONSES_API_ENABLED: 'true',
    });

    const res = await request(makeApp()).put('/api/providers/nemotron').send({
      apiKey: 'open-model-key',
      baseUrl: null,
      responsesApiEnabled: false,
    });

    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(cfg.OPEN_MODEL_API_KEY).toBe('open-model-key');
    expect(cfg.NEMOTRON_API_KEY).toBeUndefined();
    expect(cfg.NVIDIA_API_KEY).toBeUndefined();
    expect(cfg.OPEN_MODEL_BASE_URL).toBeUndefined();
    expect(cfg.NEMOTRON_BASE_URL).toBeUndefined();
    expect(cfg.OPEN_MODEL_RESPONSES_API_ENABLED).toBe('false');
    expect(cfg.NEMOTRON_RESPONSES_API_ENABLED).toBeUndefined();
  });

  it('stores model updates in agent settings without restarting the daemon', async () => {
    writeLocalConfigFile({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'openai-key',
    });

    const res = await request(makeApp())
      .patch('/api/providers/openai/model')
      .send({ model: 'gpt-5.6' });

    expect(res.status).toBe(200);
    expect(mocks.updateAgentSettings).toHaveBeenCalledWith({ openaiModel: 'gpt-5.6' });
    expect(res.body).toEqual(
      expect.objectContaining({
        model: 'gpt-5.6',
        activeModel: 'gpt-5.6',
        restartScheduled: false,
      }),
    );

    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('uses OMNIKEY_CONFIG_PATH for provider reads and writes without touching the default config', async () => {
    const customConfigPath = path.join(tmpDir, 'custom', 'daemon-config.json');
    const defaultPath = defaultConfigPath(tmpDir);
    process.env.OMNIKEY_CONFIG_PATH = customConfigPath;

    writeConfigAt(customConfigPath, {
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-anthropic-file-1234',
      OPENAI_API_KEY: 'sk-openai-file-1234',
    });
    writeConfigAt(defaultPath, {
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-default-openai-0000',
    });
    const defaultBefore = fs.readFileSync(defaultPath, 'utf-8');

    const listRes = await request(makeApp()).get('/api/providers');

    expect(listRes.status).toBe(200);
    expect(listRes.body.activeProvider).toBe('anthropic');
    expect(listRes.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'anthropic',
          isConfigured: true,
          apiKeyMasked: 'sk-••••••••1234',
        }),
      ]),
    );
    expect(fs.readFileSync(defaultPath, 'utf-8')).toBe(defaultBefore);

    const putRes = await request(makeApp())
      .put('/api/providers/anthropic')
      .send({ apiKey: 'sk-anthropic-new-9876' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.restartScheduled).toBe(true);
    expect(readConfigFile(customConfigPath)).toEqual(
      expect.objectContaining({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-anthropic-new-9876',
        OPENAI_API_KEY: 'sk-openai-file-1234',
      }),
    );
    expect(fs.readFileSync(defaultPath, 'utf-8')).toBe(defaultBefore);

    const activateRes = await request(makeApp()).post('/api/providers/openai/activate');

    expect(activateRes.status).toBe(200);
    expect(activateRes.body).toEqual(
      expect.objectContaining({
        activeProvider: 'openai',
        restartScheduled: true,
      }),
    );
    expect(readConfigFile(customConfigPath).AI_PROVIDER).toBe('openai');
    expect(fs.readFileSync(defaultPath, 'utf-8')).toBe(defaultBefore);

    const modelRes = await request(makeApp())
      .patch('/api/providers/openai/model')
      .send({ model: 'gpt-custom-5' });

    expect(modelRes.status).toBe(200);
    expect(mocks.updateAgentSettings).toHaveBeenCalledWith({ openaiModel: 'gpt-custom-5' });
    expect(modelRes.body.activeModel).toBe('gpt-custom-5');
    expect(fs.readFileSync(defaultPath, 'utf-8')).toBe(defaultBefore);
  });
});
