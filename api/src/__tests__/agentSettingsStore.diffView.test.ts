import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Logger } from 'winston';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real SQLite file per test so "persists across instances" means a fresh
// module graph (new Sequelize, new model) reading the same database file.
let sqlitePath = '';
let configDir = '';

vi.mock('../config', () => ({
  config: {
    get isSelfHosted() {
      return true;
    },
    get sqlitePath() {
      return sqlitePath;
    },
    dbLogging: false,
    aiProvider: 'openai',
    browserAccessEnabled: false,
    browserDebugExecutable: undefined,
    terminalAccess: 'full',
    usageRecordingEnabled: true,
    webSearchEnabled: true,
  },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

async function freshInstance() {
  vi.resetModules();
  const db = await import('../db');
  await import('../models/agentSettings');
  await db.sequelize.sync();
  const store = await import('../agentSettingsStore');
  return { db, store };
}

describe('agent settings diffViewEnabled persistence', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-diff-view-'));
    sqlitePath = path.join(configDir, 'settings.sqlite');
    process.env = { ...originalEnv, OMNIKEY_CONFIG_PATH: path.join(configDir, 'config.json') };
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('defaults to true for a new settings row', async () => {
    const { db, store } = await freshInstance();
    const settings = await store.getAgentSettings();
    expect(settings.diffViewEnabled).toBe(true);
    await db.sequelize.close();
  });

  it('persists false and true across separate store instances', async () => {
    const first = await freshInstance();
    const updated = await first.store.updateAgentSettings({ diffViewEnabled: false });
    expect(updated.diffViewEnabled).toBe(false);
    await first.db.sequelize.close();

    const second = await freshInstance();
    expect((await second.store.getAgentSettings()).diffViewEnabled).toBe(false);
    // Unrelated patches never reset the toggle.
    await second.store.updateAgentSettings({ webSearchEnabled: false });
    expect((await second.store.getAgentSettings()).diffViewEnabled).toBe(false);
    await second.store.updateAgentSettings({ diffViewEnabled: true });
    await second.db.sequelize.close();

    const third = await freshInstance();
    expect((await third.store.getAgentSettings()).diffViewEnabled).toBe(true);
    await third.db.sequelize.close();
  });

  it('migrates a legacy agent_settings table without the column to enabled', async () => {
    // Build the pre-feature schema directly, with an existing row.
    const { Sequelize } = await import('sequelize');
    const legacy = new Sequelize({ dialect: 'sqlite', storage: sqlitePath, logging: false });
    await legacy.query(`CREATE TABLE agent_settings (
      id VARCHAR(255) PRIMARY KEY NOT NULL,
      terminal_access VARCHAR(255) NOT NULL DEFAULT 'full',
      web_search_enabled TINYINT(1) NOT NULL DEFAULT 1,
      usage_recording_enabled TINYINT(1) NOT NULL DEFAULT 1,
      browser_access_enabled TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME, updated_at DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await legacy.query(
      `INSERT INTO agent_settings (id, terminal_access) VALUES ('default', 'limited')`,
    );
    await legacy.close();

    vi.resetModules();
    const db = await import('../db');
    // Every table the boot-time column migrations touch must exist.
    await Promise.all([
      import('../models/agentSettings'),
      import('../models/subscription'),
      import('../models/subscriptionUsage'),
      import('../models/agentSession'),
      import('../models/agentTranscriptMessage'),
      import('../models/agentSessionDiff'),
      import('../models/mcpServer'),
    ]);
    // runSQLiteMigrations is internal; initDatabase runs it after sync().
    // Stub the post-migration imports that need unrelated tables.
    vi.doMock('../agent/defaultSelfHostedSeeds', () => ({
      seedDefaultSelfHostedAgentAssets: vi.fn(),
    }));
    vi.doMock('../agent/backfillTaskInstructions', () => ({
      backfillSessionTaskInstructions: vi.fn(),
    }));
    await db.initDatabase(silentLogger);
    const [columns] = (await db.sequelize.query('PRAGMA table_info(agent_settings)')) as [
      Array<{ name: string }>,
      unknown,
    ];
    expect(columns.map((c) => c.name)).toContain('diff_view_enabled');

    const store = await import('../agentSettingsStore');
    const settings = await store.getAgentSettings();
    expect(settings.terminalAccess).toBe('limited');
    expect(settings.diffViewEnabled).toBe(true);
    await db.sequelize.close();
  });
});

describe('readDiffViewEnabled compatibility', () => {
  it('treats only explicit false-like values as disabled', async () => {
    vi.resetModules();
    const { readDiffViewEnabled } = await import('../agentSettingsStore');
    for (const value of [undefined, null, true, 1, '1', 'true', 'unexpected']) {
      expect(readDiffViewEnabled(value)).toBe(true);
    }
    for (const value of [false, 0, '0', 'false', ' FALSE ']) {
      expect(readDiffViewEnabled(value)).toBe(false);
    }
  });
});
