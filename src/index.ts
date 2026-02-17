import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import winston, { Logger } from 'winston';
import util from 'util';
import { EnhanceCommand } from './types';
import { readTaskPrompt } from './read-task-prompt';
import {
  enhancePromptSystemInstruction,
  grammarPromptSystemInstruction,
  OUTPUT_FORMAT_INSTRUCTION,
} from './prompts';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = 7172;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }),
    winston.format.printf((info) => {
      const { level, message, timestamp, metadata } = info as {
        level: string;
        message: string;
        timestamp: string;
        metadata?: unknown;
      };

      const isLocal = process.env.LOCAL === 'true';

      let metaString = '';
      if (
        metadata &&
        (typeof metadata === 'object' ? Object.keys(metadata as object).length > 0 : true)
      ) {
        if (isLocal) {
          metaString = `\n${util.inspect(metadata, { colors: true, depth: null, breakLength: 80 })}`;
        } else {
          metaString = ` ${JSON.stringify(metadata)}`;
        }
      }

      const base = `${timestamp} [${level}] ${message}`;
      return isLocal
        ? winston.format.colorize().colorize(level, `${base}${metaString}`)
        : `${base}${metaString}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

interface EnhanceRequestBody {
  text?: string;
}

function parseImprovedTextResponse(response: string): string {
  const match = response.match(/<improved_text>([\s\S]*?)<\/improved_text>/);
  if (match && match[1]) {
    return match[1].trim();
  }
  logger.warn(
    'LLM response did not contain expected <improved_text> tags; returning raw response.',
  );
  return response.trim();
}

const prompts: Record<EnhanceCommand, string> = {
  enhance: enhancePromptSystemInstruction,
  grammar: grammarPromptSystemInstruction,
  task: readTaskPrompt(logger),
};

async function enhanceText(logger: Logger, text: string, cmd: EnhanceCommand): Promise<string> {
  const trimmed = text.trim();

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY is not set; returning original text with marker.');
    return trimmed;
  }

  try {
    const systemPrompt = prompts[cmd];

    if (!systemPrompt) {
      logger.error(`No system prompt found for command: ${cmd}`);
      return trimmed;
    }

    const finalSystemPrompt = `${systemPrompt}\n${OUTPUT_FORMAT_INSTRUCTION}`;

    const completion = await openai.chat.completions.create({
      model: cmd === 'task' ? 'gpt-5.1' : 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.3,
    });

    const enhanced = completion.choices[0]?.message?.content?.trim();

    if (!enhanced) {
      logger.warn('LLM returned empty content; falling back to original text.');
      return trimmed;
    }

    logger.info(`LLM response received for command "${cmd}", length: ${enhanced.length}`);

    return parseImprovedTextResponse(enhanced);
  } catch (err) {
    logger.error(`Error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`);
    return trimmed;
  }
}

async function handleEnhance(cmd: EnhanceCommand, req: Request, res: Response) {
  logger.defaultMeta = { traceId: randomUUID() };
  const body = req.body as EnhanceRequestBody;
  logger.info(
    `Received request for command "${cmd}" with text length: ${body.text ? body.text.length : 0}`,
  );

  if (!body || typeof body.text !== 'string' || body.text.trim() === '') {
    logger.warn('Enhance request missing or empty "text" field.');
    return res.status(400).json({ error: 'Missing or empty "text" field in request body.' });
  }

  const result = await enhanceText(logger, body.text, cmd);

  return res.json({ result });
}

// Main endpoint used by the macOS app
app.post('/api/enhance', handleEnhance.bind(null, 'enhance'));

// Alias endpoint in case the client uses /api/enhancer
app.post('/api/enhancer', handleEnhance.bind(null, 'enhance'));

app.post('/api/grammar', handleEnhance.bind(null, 'grammar'));

app.post('/api/custom-task', handleEnhance.bind(null, 'task'));

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

const server = app.listen(PORT, () => {
  logger.info(`Enhancer API listening on http://localhost:${PORT}`);
});

function gracefulShutdown(signal: NodeJS.Signals) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

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
