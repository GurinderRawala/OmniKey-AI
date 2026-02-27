import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { Logger } from 'winston';
import zod from 'zod';
import { EnhanceCommand } from './types';
import {
  enhancePromptSystemInstruction,
  grammarPromptSystemInstruction,
  OUTPUT_FORMAT_INSTRUCTION,
} from './prompts';
import { config } from './config';
import { AuthLocals, authMiddleware } from './authMiddleware';
import { Subscription } from './models/subscription';
import { SubscriptionUsage } from './models/subscriptionUsage';
import { decompressString } from './compression';

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

const enhanceRequestSchema = zod.object({
  text: zod.string().max(10000, 'Text must be at most 10000 characters long.'),
});

export function createFeatureRouter(): express.Router {
  const router = express.Router();

  async function enhanceText(
    logger: Logger,
    text: string,
    cmd: EnhanceCommand,
    subscription: Subscription,
  ): Promise<string> {
    const trimmed = text.trim();

    if (!config.openaiApiKey) {
      logger.warn('OPENAI_API_KEY is not set; returning original text with marker.');
      return trimmed;
    }

    try {
      const prompts: Record<EnhanceCommand, string> = {
        enhance: enhancePromptSystemInstruction,
        grammar: grammarPromptSystemInstruction,
        task: decompressString(subscription.taskInstructions) ?? '',
      };
      const systemPrompt = prompts[cmd];

      if (!systemPrompt) {
        logger.error(`No system prompt found for command: ${cmd}`);
        return trimmed;
      }

      const finalSystemPrompt = `${systemPrompt}\n${OUTPUT_FORMAT_INSTRUCTION}`;

      const model = cmd === 'task' ? 'gpt-5.1' : 'gpt-4.1-mini';

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: finalSystemPrompt },
          { role: 'user', content: trimmed },
        ],
        temperature: 0.3,
      });

      // Record token usage for this subscription and model, if usage
      // data is available and we know which subscription made the call.
      const usage = completion.usage;
      if (usage && subscription.id) {
        try {
          await SubscriptionUsage.create({
            subscriptionId: subscription.id,
            model,
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          });

          await Subscription.increment('totalTokensUsed', {
            by: usage.total_tokens ?? 0,
            where: { id: subscription.id },
          });
        } catch (err) {
          logger.error('Failed to record subscription usage metrics.', {
            error: err,
            subscriptionId: subscription.id,
          });
        }
      }

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
      const { logger, subscription } = res.locals;
      try {
        const body = enhanceRequestSchema.parse(req.body);

        const result = await enhanceText(logger, body.text, cmd, subscription);

        return res.json({ result });
      } catch (err) {
        logger.error('Error processing enhance request.', { error: err });
        return res.status(500).json({ error: 'Internal server error.' });
      }
    };
  }

  // Main endpoints used by the macOS app
  router.post('/enhance', authMiddleware, makeEnhanceHandler('enhance'));

  router.post('/grammar', authMiddleware, makeEnhanceHandler('grammar'));

  router.post('/custom-task', authMiddleware, makeEnhanceHandler('task'));

  return router;
}
