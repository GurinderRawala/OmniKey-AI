import path from 'path';
import fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { request as httpsRequest } from 'https';
import inquirer from 'inquirer';
import { getConfigDir, getConfigPath, readConfig, initLogFiles } from './utils';

const REQUIRED_ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;
type RequiredKey = (typeof REQUIRED_ENV_KEYS)[number];

interface PromptOptions {
  /** When true, never prompt — throw if anything is missing. */
  nonInteractive?: boolean;
}

/**
 * Where the bundled bot lives at runtime. The CLI's `build:telegram-client`
 * script populates this directory with the bot's compiled output plus its
 * production `node_modules`.
 */
function resolveBundleRoot(): string {
  // dist/telegramClient.js → ../telegram-client-dist
  return path.resolve(__dirname, '..', 'telegram-client-dist');
}

function resolveBundledEntry(): string {
  return path.join(resolveBundleRoot(), 'dist', 'index.js');
}

function persistConfig(values: Record<string, string>): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const existing = readConfig();
  const merged = { ...existing, ...values };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Verify a Telegram bot token via the Bot API's getMe endpoint.
 * Resolves to the bot's @username on success, throws on failure.
 */
function verifyToken(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'GET',
        hostname: 'api.telegram.org',
        path: `/bot${token}/getMe`,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as {
              ok: boolean;
              description?: string;
              result?: { username?: string };
            };
            if (!parsed.ok) {
              reject(new Error(parsed.description || 'Telegram rejected the token'));
              return;
            }
            resolve(parsed.result?.username || 'bot');
          } catch (err) {
            reject(new Error(`Invalid JSON from Telegram: ${body}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Ensure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are present in
 * ~/.omnikey/config.json. Prompts for any missing values (unless
 * `nonInteractive` is set) and validates the token against the Bot API.
 *
 * Returns the resolved config values (existing or newly captured).
 */
export async function ensureTelegramConfig(
  options: PromptOptions = {},
): Promise<Record<RequiredKey, string>> {
  const existing = readConfig();
  const resolved: Partial<Record<RequiredKey, string>> = {};
  const missing: RequiredKey[] = [];

  for (const key of REQUIRED_ENV_KEYS) {
    const value = existing[key];
    if (typeof value === 'string' && value.trim() !== '') {
      resolved[key] = value.trim();
    } else {
      missing.push(key);
    }
  }

  if (missing.length === 0) {
    return resolved as Record<RequiredKey, string>;
  }

  if (options.nonInteractive) {
    throw new Error(
      `Missing required Telegram config in ${getConfigPath()}: ${missing.join(', ')}`,
    );
  }

  console.log('\nTelegram client configuration required.');
  console.log(
    'See telegram-bot/README.md for how to create a bot with @BotFather and find your chat id.\n',
  );

  const toPersist: Record<string, string> = {};

  if (missing.includes('TELEGRAM_BOT_TOKEN')) {
    const { token } = await inquirer.prompt<{ token: string }>([
      {
        type: 'password',
        name: 'token',
        mask: '*',
        message: 'Enter your Telegram bot token (from @BotFather):',
        validate: (input: string) =>
          /^\d+:[A-Za-z0-9_-]{20,}$/.test(input.trim()) ||
          'Token should look like 123456789:ABC... (digits, colon, 20+ chars)',
      },
    ]);
    try {
      const username = await verifyToken(token.trim());
      console.log(`Token validated for @${username}.`);
    } catch (err) {
      throw new Error(
        `Telegram rejected the token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    resolved.TELEGRAM_BOT_TOKEN = token.trim();
    toPersist.TELEGRAM_BOT_TOKEN = token.trim();
  }

  if (missing.includes('TELEGRAM_CHAT_ID')) {
    const { chatId } = await inquirer.prompt<{ chatId: string }>([
      {
        type: 'input',
        name: 'chatId',
        message:
          'Enter the chat id to receive notifications (curl https://api.telegram.org/bot<token>/getUpdates):',
        validate: (input: string) =>
          /^-?\d+$/.test(input.trim()) || 'Chat id must be a numeric value (groups are negative)',
      },
    ]);
    resolved.TELEGRAM_CHAT_ID = chatId.trim();
    toPersist.TELEGRAM_CHAT_ID = chatId.trim();
  }

  if (Object.keys(toPersist).length > 0) {
    persistConfig(toPersist);
    console.log(`Saved Telegram config to ${getConfigPath()}.`);
  }

  return resolved as Record<RequiredKey, string>;
}

/**
 * Spawn the bundled telegram-bot server as a long-lived child process.
 * The bot reads PORT from process.env (defaults to 7072 in the app), so we
 * inject the CLI's chosen port that way to keep the upstream code untouched.
 */
export function spawnTelegramClient(port: number, env: Record<string, string>): ChildProcess {
  const bundleRoot = resolveBundleRoot();
  const entry = resolveBundledEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Bundled telegram-client not found at ${entry}. ` +
        'Reinstall omnikey-cli or run `npm run build` from the cli/ directory.',
    );
  }

  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const logPath = path.join(configDir, 'telegram-client.log');
  const errorLogPath = path.join(configDir, 'telegram-client-error.log');
  const { out, err } = initLogFiles(logPath, errorLogPath);

  const child = spawn(process.execPath, [entry], {
    detached: false,
    stdio: ['ignore', out, err],
    // cwd = bundle root so the bot's dotenv.config() and relative paths line up
    cwd: bundleRoot,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
    },
  });

  child.on('exit', (code, signal) => {
    fs.closeSync(out);
    fs.closeSync(err);
    if (code !== 0) {
      console.error(`telegram-client exited with code=${code} signal=${signal ?? 'none'}`);
    }
  });

  return child;
}

/** Top-level command: `omnikey telegram-client [--port <port>]`. */
export async function startTelegramClientCommand(port: number): Promise<void> {
  const cfg = await ensureTelegramConfig();
  const child = spawnTelegramClient(port, cfg);
  console.log(
    `telegram-client started (pid=${child.pid}) on port ${port}. ` +
      `Logs: ${path.join(getConfigDir(), 'telegram-client.log')}`,
  );

  // Keep the CLI process alive until the child exits so users can Ctrl+C.
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    process.on('SIGINT', () => {
      child.kill('SIGINT');
    });
    process.on('SIGTERM', () => {
      child.kill('SIGTERM');
    });
  });
}
