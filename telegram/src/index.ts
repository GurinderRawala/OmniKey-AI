import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { randomUUID } from 'crypto';
import winston from 'winston';
import { z } from 'zod';
import {
  initTelegram,
  notify,
  setupMessageListener,
  stopTelegram,
  telegramErrorDetails,
} from './notifyTelegram';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { conId: randomUUID() },
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaString = Object.keys(meta).length ? JSON.stringify(meta) : '';
      const date = new Date(timestamp as string).toLocaleString();
      return `[${date}] ${level}: ${message} ${metaString}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

const app = express();
const DEFAULT_PORT = 6666;
const TELEGRAM_PORT_ENV = 'OMNIKEY_TELEGRAM_PORT';

function resolvePort(): number {
  const envPort = process.env[TELEGRAM_PORT_ENV];
  if (!envPort) return DEFAULT_PORT;

  const parsedPort = Number(envPort);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    return parsedPort;
  }

  logger.warn(`Invalid ${TELEGRAM_PORT_ENV}; using default port`, {
    value: envPort,
    defaultPort: DEFAULT_PORT,
  });
  return DEFAULT_PORT;
}

const port = resolvePort();

const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
if (botToken) {
  try {
    const bot = initTelegram(botToken);
    logger.info('Telegram bot initialized', {
      botTokenSet: !!botToken,
      bot: !!bot,
    });

    setupMessageListener(logger, bot);
  } catch (e) {
    logger.error('Failed to init telegram:', e);
  }
}

app.use(express.json());

const sendBodySchema = z.object({
  message: z.string().min(1, 'message must not be empty'),
  parseMode: z.enum(['Markdown', 'MarkdownV2', 'HTML']).optional(),
});

app.get('/', (req, res) => {
  res.send('Telegram bot service (TypeScript)');
});

app.post('/telegram/send', async (req, res) => {
  const requestLogger = logger.child({ conId: `telegram-send:${randomUUID()}` });
  const parsed = sendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    requestLogger.warn('Invalid /telegram/send body', {
      issues: parsed.error.issues,
    });
    return res.status(400).json({
      message: 'Invalid request body',
      issues: parsed.error.issues,
    });
  }

  const { message, parseMode } = parsed.data;
  try {
    await notify(requestLogger, message, { parseMode });
    return res.json({
      message: 'Message sent',
      parseMode: parseMode ?? 'Markdown',
    });
  } catch (e) {
    requestLogger.error('Failed to send message', telegramErrorDetails(e));
    const description =
      (e as { response?: { body?: { description?: string } } })?.response?.body?.description ??
      (e as Error).message;
    return res.status(502).json({
      message: 'Failed to deliver message to Telegram',
      error: description,
    });
  }
});

const server = app.listen(port, () => {
  logger.info(`Server listening on http://localhost:${port}`);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}. Shutting down...`);

  const hardExit = setTimeout(() => {
    logger.warn('Timed out during shutdown; exiting forcefully');
    process.exit(1);
  }, 5_000);
  hardExit.unref();

  await stopTelegram(logger);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(hardExit);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
