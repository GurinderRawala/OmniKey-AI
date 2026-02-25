import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { Logger } from 'winston';
import { EnhanceCommand } from './types';
import {
  enhancePromptSystemInstruction,
  grammarPromptSystemInstruction,
  OUTPUT_FORMAT_INSTRUCTION,
} from './prompts';
import { readTaskPrompt } from './read-task-prompt';
import { config } from './config';
import { AuthLocals, authMiddleware } from './authMiddleware';

interface EnhanceRequestBody {
  text?: string;
}

function parseImprovedTextResponse(logger: Logger, response: string): string {
  const match = response.match(/<improved_text>([\s\S]*?)<\/improved_text>/);
  if (match && match[1]) {
    return match[1].trim();
  }
  logger.warn(
    'LLM response did not contain expected <improved_text> tags; returning raw response.',
  );
  return response.trim();
}

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

export function createFeatureRouter(logger: Logger): express.Router {
  const router = express.Router();

  const prompts: Record<EnhanceCommand, string> = {
    enhance: enhancePromptSystemInstruction,
    grammar: grammarPromptSystemInstruction,
    task: readTaskPrompt(logger),
  };

  async function enhanceText(logger: Logger, text: string, cmd: EnhanceCommand): Promise<string> {
    const trimmed = text.trim();

    if (!config.openaiApiKey) {
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

      return parseImprovedTextResponse(logger, enhanced);
    } catch (err) {
      logger.error(`Error calling OpenAI: ${err instanceof Error ? err.message : String(err)}`);
      return trimmed;
    }
  }

  function makeEnhanceHandler(cmd: EnhanceCommand) {
    return async (req: Request, res: Response<any, AuthLocals>) => {
      const { logger } = res.locals;
      const body = req.body as EnhanceRequestBody;
      logger.info(
        `Received request for command "${cmd}" with text length: ${
          body.text ? body.text.length : 0
        }`,
      );

      if (!body || typeof body.text !== 'string' || body.text.trim() === '') {
        logger.warn('Enhance request missing or empty "text" field.');
        return res.status(400).json({ error: 'Missing or empty "text" field in request body.' });
      }

      const result = await enhanceText(logger, body.text, cmd);

      return res.json({ result });
    };
  }

  // Main endpoints used by the macOS app
  router.post('/enhance', authMiddleware, makeEnhanceHandler('enhance'));

  // Alias endpoint in case the client uses /api/enhancer
  router.post('/enhancer', authMiddleware, makeEnhanceHandler('enhance'));

  router.post('/grammar', authMiddleware, makeEnhanceHandler('grammar'));

  router.post('/custom-task', authMiddleware, makeEnhanceHandler('task'));

  return router;
}
