import dotenv from 'dotenv';

dotenv.config();

function getEnv(name: string, required = false): string | undefined {
  const value = process.env[name];
  if (required && (value === undefined || value === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getBooleanEnv(name: string, defaultValue = false): boolean {
  const value = getEnv(name);
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function getNumberEnv(name: string, defaultValue?: number): number {
  const value = getEnv(name);
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

export const config = {
  // Server
  logLevel: getEnv('LOG_LEVEL') || 'info',
  isLocal: getBooleanEnv('LOCAL', false),

  // OpenAI
  openaiApiKey: getEnv('OPENAI_API_KEY'),

  // Database
  databaseUrl: getEnv('DATABASE_URL', true)!,
  dbLogging: getBooleanEnv('DB_LOGGING', false),

  // Crypto
  appEncryptionKey: getEnv('APP_ENCRYPTION_KEY'),

  // JWT / auth
  jwtSecret: getEnv('JWT_SECRET', true)!,
  // Expiry in seconds
  jwtExpiresInSeconds: getNumberEnv('JWT_EXPIRES_IN_SECONDS', 3600),

  // Apple receipt validation shared secret (for auto‑renewable subscriptions)
  appleSharedSecret: getEnv('APPLE_SHARED_SECRET'),
};
