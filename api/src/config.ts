import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getLocalConfigPath } from './localConfigFile';

dotenv.config();

function loadLocalConfigFileIntoEnv(): void {
  const configPath = getLocalConfigPath();

  if (!fs.existsSync(configPath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (process.env[key] !== undefined || value === undefined || value === null) continue;
      process.env[key] = String(value);
    }
  } catch {
    // Keep config loading best-effort. The normal required-env validation below
    // will still fail loudly if a necessary provider key is unavailable.
  }
}

loadLocalConfigFileIntoEnv();

function getEnv<T = true>(name: string, required: T): T extends true ? string : string | undefined {
  const value = process.env[name];
  if (required && (value === undefined || value === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value as T extends true ? string : string | undefined;
}

function getBooleanEnv(name: string, defaultValue = false): boolean {
  const value = getEnv(name, false);
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function getFirstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = getEnv(name, false);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function getFirstBooleanEnv(names: string[], defaultValue = false): boolean {
  for (const name of names) {
    const value = getEnv(name, false);
    if (value !== undefined && value !== '') {
      return value.toLowerCase() === 'true' || value === '1';
    }
  }
  return defaultValue;
}

function getNumberEnv(name: string, defaultValue?: number): number {
  const value = getEnv(name, false);
  if (value === undefined || value === '') {
    if (defaultValue === undefined) {
      throw new Error(`Missing required numeric environment variable: ${name}`);
    }
    return defaultValue;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${value}`);
  }
  return parsed;
}

function getSqlitePath() {
  const envPath = getEnv('SQLITE_PATH', false);
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const defaultPath = path.join(homeDir, '.omnikey', 'omnikey-selfhosted.sqlite');
  if (!envPath) return defaultPath;
  return path.isAbsolute(envPath) ? envPath : path.join(homeDir, '.omnikey', envPath);
}

export type AIProvider = 'openai' | 'gemini' | 'anthropic' | 'nemotron';

export type TerminalAccessMode = 'full' | 'limited';

function getTerminalAccessMode(): TerminalAccessMode {
  const value = getEnv('TERMINAL_ACCESS', false);
  if (value === 'limited') return 'limited';
  return 'full';
}

function getAIProvider(): AIProvider {
  const value = getEnv('AI_PROVIDER', false);
  if (value === 'open_model' || value === 'open-model' || value === 'openmodel') {
    return 'nemotron';
  }
  if (value === 'gemini' || value === 'anthropic' || value === 'openai' || value === 'nemotron') {
    return value;
  }
  // Auto-detect from available keys
  if (getEnv('ANTHROPIC_API_KEY', false)) return 'anthropic';
  if (getEnv('GEMINI_API_KEY', false)) return 'gemini';
  if (getFirstEnv('OPEN_MODEL_API_KEY', 'NEMOTRON_API_KEY', 'NVIDIA_API_KEY')) return 'nemotron';
  return 'openai';
}

function getActiveApiKey(provider: AIProvider): string {
  if (provider === 'openai') return getEnv('OPENAI_API_KEY', true) as string;
  if (provider === 'anthropic') return getEnv('ANTHROPIC_API_KEY', true) as string;
  if (provider === 'gemini') return getEnv('GEMINI_API_KEY', true) as string;
  if (provider === 'nemotron') {
    // The provider id remains "nemotron" for backward compatibility, but new
    // installs use generic OPEN_MODEL_* names because any OpenAI-compatible
    // endpoint can be targeted here. Legacy keys still work.
    const explicit = getFirstEnv('OPEN_MODEL_API_KEY', 'NEMOTRON_API_KEY', 'NVIDIA_API_KEY');
    if (explicit) return explicit;
    return getEnv('OPEN_MODEL_API_KEY', true) as string;
  }
  throw new Error(`Unknown AI provider: ${provider}`);
}

const _provider = getAIProvider();

export const config = {
  // Server
  logLevel: getEnv('LOG_LEVEL', false) || 'info',
  isLocal: getBooleanEnv('LOCAL', false),

  // AI provider
  aiProvider: _provider as AIProvider,
  aiApiKey: getActiveApiKey(_provider),

  // Legacy — kept for backwards compatibility; may be undefined when using another provider
  openaiApiKey: getEnv('OPENAI_API_KEY', false),

  // Optional override for the OpenAI-compatible open-model endpoint. Defaults to
  // NVIDIA's public NIM gateway when unset; point this at LM Studio, vLLM,
  // Ollama/OpenAI-compatible gateways, or a private NIM deployment as needed.
  nemotronBaseUrl: getFirstEnv('OPEN_MODEL_BASE_URL', 'NEMOTRON_BASE_URL'),
  nemotronResponsesApiEnabled: getFirstBooleanEnv(
    ['OPEN_MODEL_RESPONSES_API_ENABLED', 'NEMOTRON_RESPONSES_API_ENABLED'],
    false,
  ),

  // Legacy OpenAI model override. This is read only by the agent-settings
  // migration path; runtime model selection is stored in SQLite so updates from
  // the desktop model picker become the single source of truth.
  openaiModel: getEnv('OPENAI_MODEL', false),

  // Optional context-window override (in tokens). Leave unset (0) to use the
  // realistic per-model default resolved in ai-client. Set this when a
  // deployment's real window differs from the model's published default — most
  // notably a self-hosted NIM serving Nemotron with VLLM_ALLOW_LONG_MAX_MODEL_LEN
  // enabled, where the window can be raised from the 256K native default to 1M.
  aiContextWindowOverride: getNumberEnv('AI_CONTEXT_WINDOW', 0),

  // Database
  databaseUrl: getEnv('DATABASE_URL', getBooleanEnv('IS_SELF_HOSTED', false) ? false : true),
  dbLogging: getBooleanEnv('DB_LOGGING', false),
  sqlitePath: getSqlitePath(),

  // Crypto
  appEncryptionKey: getEnv('APP_ENCRYPTION_KEY', false),

  // JWT / auth
  jwtSecret: getEnv('JWT_SECRET', false) || 'default_jwt_secret_change_me',
  // Expiry in seconds
  jwtExpiresInSeconds: getNumberEnv('JWT_EXPIRES_IN_SECONDS', 2 * 60 * 60), // default 2 hours
  internalApiKey: getEnv('INTERNAL_API_KEY', false),
  port: getNumberEnv('OMNIKEY_PORT', 8080),
  isSelfHosted: getBooleanEnv('IS_SELF_HOSTED', false),
  // Web search providers (all optional — DuckDuckGo is used as free fallback)
  serperApiKey: getEnv('SERPER_API_KEY', false),
  braveSearchApiKey: getEnv('BRAVE_SEARCH_API_KEY', false),
  tavilyApiKey: getEnv('TAVILY_API_KEY', false),
  searxngUrl: getEnv('SEARXNG_URL', false),

  terminalPlatform: getEnv('TERMINAL_PLATFORM', false),
  blockSaas: getBooleanEnv('BLOCK_SAAS', false),

  // User-configured CDP debug port (set by `omnikey grant-browser-access`)
  browserDebugPort: (() => {
    const raw = getEnv('BROWSER_DEBUG_PORT', false);
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  })(),
  browserDebugBrowserName: getEnv('BROWSER_DEBUG_BROWSER_NAME', false),
  browserDebugExecutable: getEnv('BROWSER_DEBUG_EXECUTABLE', false),
  browserDebugUserDataDir: getEnv('BROWSER_DEBUG_USER_DATA_DIR', false),

  // Agent capability toggles, surfaced in the macOS Settings UI.
  // terminalAccess controls how broad the shell tool is — 'full' exposes the
  // shell_script tool as-is; 'limited' restricts the tool description so the
  // model only runs read-only / safe commands and the prompts discourage
  // mutating operations.
  terminalAccess: getTerminalAccessMode(),
  // webSearchEnabled controls whether web_search / web_fetch tools are
  // registered with the agent at all. Defaults to true.
  webSearchEnabled: getBooleanEnv('WEB_SEARCH_ENABLED', true),
  // browserAccessEnabled toggles authenticated browser session reading.
  // Setting it to true triggers `omnikey grant-browser-access` from the
  // settings endpoint (similar to `restart-daemon`).
  browserAccessEnabled: getBooleanEnv('BROWSER_ACCESS_ENABLED', false),
  // usageRecordingEnabled controls whether detailed per-call token usage rows
  // are persisted for the Usage dashboard. Cloud defaults to true to preserve
  // existing accounting; self-hosted defaults to false for local privacy and
  // storage until the user explicitly enables it in Settings.
  usageRecordingEnabled: getBooleanEnv(
    'USAGE_RECORDING_ENABLED',
    !getBooleanEnv('IS_SELF_HOSTED', false),
  ),

  // GCS download-count tracking (both must be set to enable counting)
  gcsBucketName: getEnv('GCS_BUCKET_NAME', false),
  gcsDownloadCountObject: getEnv('GCS_DOWNLOAD_COUNT_OBJECT', false),
};
