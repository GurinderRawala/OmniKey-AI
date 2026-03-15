"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function getEnv(name, required) {
    const value = process.env[name];
    if (required && (value === undefined || value === '')) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function getBooleanEnv(name, defaultValue = false) {
    const value = getEnv(name, false);
    if (value === undefined)
        return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}
function getNumberEnv(name, defaultValue) {
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
exports.config = {
    // Server
    logLevel: getEnv('LOG_LEVEL', false) || 'info',
    isLocal: getBooleanEnv('LOCAL', false),
    // OpenAI
    openaiApiKey: getEnv('OPENAI_API_KEY', true),
    // Database
    databaseUrl: getEnv('DATABASE_URL', getBooleanEnv('IS_SELF_HOSTED', false) ? false : true),
    dbLogging: getBooleanEnv('DB_LOGGING', false),
    sqlitePath: getEnv('SQLITE_PATH', false) || 'omnikey-selfhosted.sqlite',
    // Crypto
    appEncryptionKey: getEnv('APP_ENCRYPTION_KEY', false),
    // JWT / auth
    jwtSecret: getEnv('JWT_SECRET', false) || 'default_jwt_secret_change_me',
    // Expiry in seconds
    jwtExpiresInSeconds: getNumberEnv('JWT_EXPIRES_IN_SECONDS', 2 * 60 * 60), // default 2 hours
    internalApiKey: getEnv('INTERNAL_API_KEY', false),
    port: getNumberEnv('OMNIKEY_PORT', 8080),
    isSelfHosted: getBooleanEnv('IS_SELF_HOSTED', false),
};
