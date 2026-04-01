import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

dotenv.config();

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

export type AIProvider = 'openai' | 'gemini' | 'anthropic';

function getAIProvider(): AIProvider {
  const value = getEnv('AI_PROVIDER', false);
  if (value === 'gemini' || value === 'anthropic' || value === 'openai') return value;
  // Auto-detect from available keys
  if (getEnv('ANTHROPIC_API_KEY', false)) return 'anthropic';
  if (getEnv('GEMINI_API_KEY', false)) return 'gemini';
  return 'openai';
}

function getActiveApiKey(provider: AIProvider): string {
  if (provider === 'openai') return getEnv('OPENAI_API_KEY', true) as string;
  if (provider === 'anthropic') return getEnv('ANTHROPIC_API_KEY', true) as string;
  if (provider === 'gemini') return getEnv('GEMINI_API_KEY', true) as string;
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
};
