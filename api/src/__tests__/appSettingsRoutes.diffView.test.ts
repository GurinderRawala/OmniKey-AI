import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const state = { diffViewEnabled: true };
  const snapshot = () => ({
    id: 'default',
    terminalAccess: 'full',
    webSearchEnabled: true,
    usageRecordingEnabled: true,
    browserAccessEnabled: false,
    browserAccessMethod: null,
    browserDebugPort: null,
    browserDebugBrowserName: null,
    browserDebugUserDataDir: null,
    browserJavascriptEventBrowsers: [],
    grammarEnhancementModel: null,
    grammarEnhancementProvider: null,
    diffViewEnabled: state.diffViewEnabled,
  });
  return {
    log,
    state,
    snapshot,
    getAgentSettings: vi.fn(async () => snapshot()),
    updateAgentSettings: vi.fn(async (patch: { diffViewEnabled?: boolean }) => {
      if (patch.diffViewEnabled !== undefined) state.diffViewEnabled = patch.diffViewEnabled;
      return snapshot();
    }),
  };
});

vi.mock('../authMiddleware', () => ({
  authMiddleware: vi.fn((_req, res, next) => {
    res.locals.logger = mocks.log;
    next();
  }),
}));
vi.mock('../config', () => ({ config: { aiProvider: 'openai' } }));
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: mocks.getAgentSettings,
  updateAgentSettings: mocks.updateAgentSettings,
  readLocalConfigFile: vi.fn(() => ({})),
  writeLocalConfigFile: vi.fn(),
}));

async function app() {
  const { appSettingsRouter } = await import('../appSettingsRoutes');
  const server = express();
  server.use(express.json());
  server.use('/api/app-settings', appSettingsRouter());
  return server;
}

describe('/api/app-settings diffViewEnabled', () => {
  beforeEach(() => {
    mocks.state.diffViewEnabled = true;
    mocks.updateAgentSettings.mockClear();
  });

  it('GET exposes diffViewEnabled (default true) at top level and in runtime', async () => {
    const res = await request(await app()).get('/api/app-settings');
    expect(res.status).toBe(200);
    expect(res.body.diffViewEnabled).toBe(true);
    expect(res.body.runtime.diffViewEnabled).toBe(true);
  });

  it('PATCH persists diffViewEnabled alone and echoes it', async () => {
    const server = await app();
    const off = await request(server).patch('/api/app-settings').send({ diffViewEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body.diffViewEnabled).toBe(false);
    expect(mocks.updateAgentSettings).toHaveBeenCalledWith({ diffViewEnabled: false });

    const read = await request(server).get('/api/app-settings');
    expect(read.body.diffViewEnabled).toBe(false);

    const on = await request(server).patch('/api/app-settings').send({ diffViewEnabled: true });
    expect(on.body.diffViewEnabled).toBe(true);
  });

  it('PATCH without diffViewEnabled leaves it untouched', async () => {
    mocks.state.diffViewEnabled = false;
    const res = await request(await app())
      .patch('/api/app-settings')
      .send({ webSearchEnabled: true });
    expect(res.status).toBe(200);
    expect(mocks.updateAgentSettings).toHaveBeenCalledWith({ webSearchEnabled: true });
    expect(res.body.diffViewEnabled).toBe(false);
  });

  it('rejects a non-boolean diffViewEnabled', async () => {
    const res = await request(await app())
      .patch('/api/app-settings')
      .send({ diffViewEnabled: 'no' });
    expect(res.status).toBe(400);
    expect(mocks.updateAgentSettings).not.toHaveBeenCalled();
  });
});
