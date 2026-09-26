import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { getConfigDir, readConfig } from './utils';

export type BrowserAccessMethod = 'debug-profile' | 'javascript-events';

export interface StoredBrowserAccessSettings {
  browserAccessEnabled: boolean;
  browserAccessMethod: BrowserAccessMethod | null;
  browserDebugPort: number | null;
  browserDebugBrowserName: string | null;
  browserDebugExecutable: string | null;
  browserDebugUserDataDir: string | null;
  browserJavascriptEventBrowsers: string[];
}

function sqlitePath(): string {
  const configured = readConfig().SQLITE_PATH;
  if (typeof configured !== 'string' || !configured.trim()) {
    return path.join(getConfigDir(), 'omnikey-selfhosted.sqlite');
  }
  return path.isAbsolute(configured) ? configured : path.join(getConfigDir(), configured);
}

function openDatabase(): sqlite3.Database {
  fs.mkdirSync(path.dirname(sqlitePath()), { recursive: true });
  const db = new sqlite3.Database(sqlitePath());
  db.configure('busyTimeout', 5_000);
  return db;
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function get<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row as T | undefined)));
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

function legacyBrowserSettings(cfg: Record<string, any>): StoredBrowserAccessSettings {
  const configuredMethod = cfg.BROWSER_ACCESS_METHOD;
  const method: BrowserAccessMethod | null =
    configuredMethod === 'debug-profile' || configuredMethod === 'javascript-events'
      ? configuredMethod
      : cfg.BROWSER_DEBUG_EXECUTABLE
        ? 'debug-profile'
        : null;
  const rawBrowsers = cfg.BROWSER_JAVASCRIPT_EVENT_BROWSERS;
  const browsers = Array.isArray(rawBrowsers)
    ? rawBrowsers.filter((value): value is string => typeof value === 'string')
    : typeof rawBrowsers === 'string'
      ? rawBrowsers
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  const rawPort = Number(cfg.BROWSER_DEBUG_PORT);
  return {
    browserAccessEnabled:
      cfg.BROWSER_ACCESS_ENABLED === true ||
      Boolean(cfg.BROWSER_DEBUG_EXECUTABLE) ||
      method !== null,
    browserAccessMethod: method,
    browserDebugPort: Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null,
    browserDebugBrowserName:
      typeof cfg.BROWSER_DEBUG_BROWSER_NAME === 'string' ? cfg.BROWSER_DEBUG_BROWSER_NAME : null,
    browserDebugExecutable:
      typeof cfg.BROWSER_DEBUG_EXECUTABLE === 'string' ? cfg.BROWSER_DEBUG_EXECUTABLE : null,
    browserDebugUserDataDir:
      typeof cfg.BROWSER_DEBUG_USER_DATA_DIR === 'string' ? cfg.BROWSER_DEBUG_USER_DATA_DIR : null,
    browserJavascriptEventBrowsers: browsers,
  };
}

async function ensureAgentSettingsSchema(db: sqlite3.Database): Promise<void> {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS agent_settings (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      terminal_access VARCHAR(255) NOT NULL DEFAULT 'full',
      web_search_enabled TINYINT(1) NOT NULL DEFAULT 1,
      usage_recording_enabled TINYINT(1) NOT NULL DEFAULT 0,
      browser_access_enabled TINYINT(1) NOT NULL DEFAULT 0,
      openai_model VARCHAR(255), anthropic_model VARCHAR(255),
      gemini_model VARCHAR(255), nemotron_model VARCHAR(255),
      grammar_enhancement_model VARCHAR(255),
      grammar_enhancement_provider VARCHAR(32),
      browser_access_method VARCHAR(32), browser_debug_port INTEGER,
      browser_debug_browser_name VARCHAR(255), browser_debug_executable VARCHAR(2000),
      browser_debug_user_data_dir VARCHAR(2000), browser_javascript_event_browsers JSON,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    )`,
    );

    const columns = await new Promise<Array<{ name: string }>>((resolve, reject) => {
      db.all('PRAGMA table_info(agent_settings)', (error, rows) =>
        error ? reject(error) : resolve(rows as Array<{ name: string }>),
      );
    });
    const existing = new Set(columns.map((column) => column.name));
    const additions: Array<[string, string]> = [
      ['terminal_access', "VARCHAR(255) NOT NULL DEFAULT 'full'"],
      ['web_search_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
      ['usage_recording_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['browser_access_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['openai_model', 'VARCHAR(255)'],
      ['anthropic_model', 'VARCHAR(255)'],
      ['gemini_model', 'VARCHAR(255)'],
      ['nemotron_model', 'VARCHAR(255)'],
      ['grammar_enhancement_model', 'VARCHAR(255)'],
      ['grammar_enhancement_provider', 'VARCHAR(32)'],
      ['browser_access_method', 'VARCHAR(32)'],
      ['browser_debug_port', 'INTEGER'],
      ['browser_debug_browser_name', 'VARCHAR(255)'],
      ['browser_debug_executable', 'VARCHAR(2000)'],
      ['browser_debug_user_data_dir', 'VARCHAR(2000)'],
      ['browser_javascript_event_browsers', 'JSON'],
    ];
    const browserColumns = new Set([
      'browser_access_enabled',
      'browser_access_method',
      'browser_debug_port',
      'browser_debug_browser_name',
      'browser_debug_executable',
      'browser_debug_user_data_dir',
      'browser_javascript_event_browsers',
    ]);
    let addedBrowserColumn = false;
    for (const [column, definition] of additions) {
      if (!existing.has(column)) {
        await run(db, `ALTER TABLE agent_settings ADD COLUMN ${column} ${definition}`);
        if (browserColumns.has(column)) addedBrowserColumn = true;
      }
    }

    const cfg = readConfig();
    const browser = legacyBrowserSettings(cfg);
    const now = new Date().toISOString();
    await run(
      db,
      `INSERT OR IGNORE INTO agent_settings
      (id, terminal_access, web_search_enabled, usage_recording_enabled,
       browser_access_enabled, browser_access_method, browser_debug_port,
       browser_debug_browser_name, browser_debug_executable, browser_debug_user_data_dir,
       browser_javascript_event_browsers, openai_model, anthropic_model, gemini_model,
       nemotron_model, createdAt, updatedAt)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cfg.TERMINAL_ACCESS === 'limited' ? 'limited' : 'full',
        cfg.WEB_SEARCH_ENABLED === false ? 0 : 1,
        cfg.USAGE_RECORDING_ENABLED === true ? 1 : 0,
        browser.browserAccessEnabled ? 1 : 0,
        browser.browserAccessMethod,
        browser.browserDebugPort,
        browser.browserDebugBrowserName,
        browser.browserDebugExecutable,
        browser.browserDebugUserDataDir,
        JSON.stringify(browser.browserJavascriptEventBrowsers),
        cfg.OPENAI_MODEL || 'gpt-5.6',
        cfg.ANTHROPIC_MODEL || 'claude-opus-4-5',
        cfg.GEMINI_MODEL || 'gemini-2.5-pro',
        cfg.OPEN_MODEL_MODEL || cfg.NEMOTRON_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
        now,
        now,
      ],
    );
    if (addedBrowserColumn && browser.browserAccessEnabled && browser.browserAccessMethod) {
      await run(
        db,
        `UPDATE agent_settings SET browser_access_enabled = 1, browser_access_method = ?,
         browser_debug_port = ?, browser_debug_browser_name = ?, browser_debug_executable = ?,
         browser_debug_user_data_dir = ?, browser_javascript_event_browsers = ?, updatedAt = ?
       WHERE id = 'default'`,
        [
          browser.browserAccessMethod,
          browser.browserDebugPort,
          browser.browserDebugBrowserName,
          browser.browserDebugExecutable,
          browser.browserDebugUserDataDir,
          JSON.stringify(browser.browserJavascriptEventBrowsers),
          now,
        ],
      );
    }
    await run(db, 'COMMIT');
  } catch (error) {
    await run(db, 'ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function saveBrowserAccessSettings(
  settings: StoredBrowserAccessSettings,
): Promise<void> {
  const db = openDatabase();
  try {
    await ensureAgentSettingsSchema(db);
    await run(
      db,
      `UPDATE agent_settings SET
        browser_access_enabled = ?, browser_access_method = ?, browser_debug_port = ?,
        browser_debug_browser_name = ?, browser_debug_executable = ?,
        browser_debug_user_data_dir = ?, browser_javascript_event_browsers = ?, updatedAt = ?
       WHERE id = 'default'`,
      [
        settings.browserAccessEnabled ? 1 : 0,
        settings.browserAccessMethod,
        settings.browserDebugPort,
        settings.browserDebugBrowserName,
        settings.browserDebugExecutable,
        settings.browserDebugUserDataDir,
        JSON.stringify(settings.browserJavascriptEventBrowsers),
        new Date().toISOString(),
      ],
    );
  } finally {
    await close(db);
  }
}

export async function readBrowserAccessSettings(): Promise<StoredBrowserAccessSettings | null> {
  const db = openDatabase();
  try {
    await ensureAgentSettingsSchema(db);
    const row = await get<Record<string, unknown>>(
      db,
      `SELECT browser_access_enabled, browser_access_method, browser_debug_port,
              browser_debug_browser_name, browser_debug_executable,
              browser_debug_user_data_dir, browser_javascript_event_browsers
       FROM agent_settings WHERE id = 'default'`,
    );
    if (!row) return null;
    let browsers: string[] = [];
    try {
      const parsed = JSON.parse(String(row.browser_javascript_event_browsers ?? '[]'));
      if (Array.isArray(parsed))
        browsers = parsed.filter((value): value is string => typeof value === 'string');
    } catch {}
    const method = row.browser_access_method;
    return {
      browserAccessEnabled: Boolean(row.browser_access_enabled),
      browserAccessMethod:
        method === 'debug-profile' || method === 'javascript-events' ? method : null,
      browserDebugPort: typeof row.browser_debug_port === 'number' ? row.browser_debug_port : null,
      browserDebugBrowserName:
        typeof row.browser_debug_browser_name === 'string' ? row.browser_debug_browser_name : null,
      browserDebugExecutable:
        typeof row.browser_debug_executable === 'string' ? row.browser_debug_executable : null,
      browserDebugUserDataDir:
        typeof row.browser_debug_user_data_dir === 'string'
          ? row.browser_debug_user_data_dir
          : null,
      browserJavascriptEventBrowsers: browsers,
    };
  } finally {
    await close(db);
  }
}
