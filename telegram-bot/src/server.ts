/**
 * OmniKey Telegram bridge.
 *
 * Exposes a tiny local HTTP server that accepts:
 *
 *   POST /telegram/send
 *   { "message": "..." }
 *
 * …and forwards the payload to Telegram's Bot API using the credentials
 * stored in ~/.omnikey/config.json (or matching environment variables).
 *
 * This file is the canonical source. The build pipeline mirrors it into
 * `telegram-client/` and bundles the compiled output as
 * `telegram-client-dist/` inside the `omnikey-cli` npm/brew artifacts.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { URL } from 'url';

interface TelegramConfig {
  token: string;
  chatId: string;
  port: number;
}

function getConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.omnikey', 'config.json');
}

function readPersistedConfig(): Record<string, unknown> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function loadConfig(overridePort?: number): TelegramConfig {
  const persisted = readPersistedConfig();

  const token =
    process.env.TELEGRAM_BOT_TOKEN || (persisted.TELEGRAM_BOT_TOKEN as string | undefined) || '';
  const chatId =
    process.env.TELEGRAM_CHAT_ID || (persisted.TELEGRAM_CHAT_ID as string | undefined) || '';
  const rawPort =
    overridePort !== undefined
      ? String(overridePort)
      : process.env.TELEGRAM_PORT || (persisted.TELEGRAM_PORT as string | undefined) || '6666';
  const port = Number(rawPort) || 6666;

  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not configured');

  return { token: String(token), chatId: String(chatId), port };
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: unknown;
}

export function sendToTelegram(
  cfg: Pick<TelegramConfig, 'token' | 'chatId'>,
  message: string,
): Promise<TelegramApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: cfg.chatId,
      text: message,
      disable_web_page_preview: true,
    });

    const url = new URL(`https://api.telegram.org/bot${cfg.token}/sendMessage`);
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as TelegramApiResponse);
          } catch (err) {
            reject(new Error(`Invalid JSON from Telegram: ${body}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const limit = 1024 * 64; // 64 KB is plenty for a chat message
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createServer(cfg: TelegramConfig): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/telegram/send') {
        jsonResponse(res, 404, { ok: false, error: 'Not Found' });
        return;
      }

      const raw = await readBody(req);
      let parsed: { message?: unknown };
      try {
        parsed = raw ? (JSON.parse(raw) as { message?: unknown }) : {};
      } catch {
        jsonResponse(res, 400, { ok: false, error: 'Body must be valid JSON' });
        return;
      }

      const message =
        typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!message) {
        jsonResponse(res, 400, { ok: false, error: '`message` must be a non-empty string' });
        return;
      }

      const result = await sendToTelegram(cfg, message);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `Telegram API rejected message (${result.error_code}): ${result.description}`,
        );
        jsonResponse(res, 502, {
          ok: false,
          error: result.description || 'Telegram API error',
          code: result.error_code,
        });
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Forwarded message to chat ${cfg.chatId} (${message.length} chars)`);
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('Unexpected error handling request:', message);
      jsonResponse(res, 500, { ok: false, error: message });
    }
  });
}

export function startTelegramClient(overridePort?: number): http.Server {
  const cfg = loadConfig(overridePort);
  const server = createServer(cfg);
  server.listen(cfg.port, () => {
    // eslint-disable-next-line no-console
    console.log(`OmniKey Telegram client listening on http://127.0.0.1:${cfg.port}`);
  });
  return server;
}

if (require.main === module) {
  let cliPort: number | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      cliPort = Number(args[++i]);
    } else if (arg.startsWith('--port=')) {
      cliPort = Number(arg.split('=')[1]);
    }
  }
  try {
    startTelegramClient(cliPort);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'Failed to start Telegram client:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}
