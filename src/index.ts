import express from 'express';
import cors from 'cors';
import { readTaskPrompt } from './read-task-prompt';
import { createSubscriptionRouter } from './subscriptionRoutes';
import { createFeatureRouter } from './featureRoutes';
import { initDatabase } from './db';
import { logger } from './logger';
import { authMiddleware } from './authMiddleware';

const app = express();
const PORT = 7172;

app.use(cors());
app.use(express.json());

app.use('/api/subscription', createSubscriptionRouter(logger));

app.use('/api', authMiddleware, createFeatureRouter(logger));

app.post('/api/create-task-instructions', (req, res) => {
  logger.info('Received request for create-task-instructions endpoint.');
  const { instructions } = req.body as { instructions?: string };
  logger.info(`Task instructions length: ${instructions ? instructions.length : 0}`);
  res.json({ message: 'task instructions saved' });
});

app.get('/api/get-task-instructions', (req, res) => {
  logger.info('Received request for get-task-instructions endpoint.');
  const instruction = readTaskPrompt(logger);
  res.json({ instruction });
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
