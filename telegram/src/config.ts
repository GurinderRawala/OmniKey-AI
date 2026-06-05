import fs from 'fs';
import path from 'path';
import os from 'os';

export interface OmnikeyConfig {
  readonly sqlitePath: string;
  readonly omnikeyPort: number;
  readonly omnikeyHost: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7071;
const DEFAULT_SQLITE = path.join(os.homedir(), '.omnikey', 'omnikey-selfhosted.sqlite');
const CONFIG_PATH = path.join(os.homedir(), '.omnikey', 'config.json');

let cached: OmnikeyConfig | null = null;

function resolveSqlitePath(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) {
    return path.isAbsolute(raw) ? raw : path.join(os.homedir(), '.omnikey', raw);
  }
  return DEFAULT_SQLITE;
}

function resolvePort(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_PORT;
}

export function loadOmnikeyConfig(): OmnikeyConfig {
  if (cached) return cached;

  let parsed: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      parsed = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    // Fall through with defaults; downstream code will surface a clearer error
    // when it actually tries to open the SQLite file or reach the API.
    parsed = {};
  }

  cached = {
    sqlitePath: resolveSqlitePath(parsed.SQLITE_PATH),
    omnikeyPort: resolvePort(parsed.OMNIKEY_PORT),
    omnikeyHost:
      typeof parsed.OMNIKEY_HOST === 'string' && parsed.OMNIKEY_HOST.trim()
        ? (parsed.OMNIKEY_HOST as string)
        : DEFAULT_HOST,
  };
  return cached;
}

export function omnikeyBaseUrl(): string {
  const { omnikeyHost, omnikeyPort } = loadOmnikeyConfig();
  return `http://${omnikeyHost}:${omnikeyPort}`;
}

export function omnikeyWsUrl(path: string): string {
  const { omnikeyHost, omnikeyPort } = loadOmnikeyConfig();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `ws://${omnikeyHost}:${omnikeyPort}${suffix}`;
}
