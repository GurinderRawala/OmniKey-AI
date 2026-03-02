import express from 'express';
import cors from 'cors';
import path from 'path';
import { createSubscriptionRouter } from './subscriptionRoutes';
import { createFeatureRouter } from './featureRoutes';
import { initDatabase } from './db';
import { logger } from './logger';
import { taskInstructionRouter } from './taskInstructionRoutes';
import { config } from './config';

const app = express();
const PORT = Number(config.port);

app.use(cors());
app.use(express.json());

app.use('/api/subscription', createSubscriptionRouter(logger));

app.use('/api/feature', createFeatureRouter());

app.use('/api/instructions', taskInstructionRouter());

app.get('/macos/download', (req, res) => {
  const dmgPath = path.join(process.cwd(), 'macOS', 'OmniKeyAI.dmg');

  res.download(dmgPath, 'OmniKeyAI.dmg', (err) => {
    if (err) {
      logger.error('Failed to send OmniKeyAI.dmg for download.', { error: err });

      if (!res.headersSent) {
        res.status(500).send('Unable to download file.');
      }
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

let server: import('http').Server | null = null;

async function start() {
  try {
    await initDatabase(logger);
    server = app.listen(PORT, () => {
      logger.info(`Enhancer API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server due to DB error.', { error: err });
    process.exit(1);
  }
}

start();

function gracefulShutdown(signal: NodeJS.Signals) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  if (!server) {
    logger.info('Server was not started or already closed. Exiting process.');
    process.exit(0);
    return;
  }

  server.close((err) => {
    if (err) {
      logger.error('Error during HTTP server shutdown.', { error: err });
      process.exitCode = 1;
      return;
    }

    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
