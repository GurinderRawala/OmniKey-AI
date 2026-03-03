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

  type CompletionUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };

  function getSystemPromptForCommand(
    cmd: EnhanceCommand,
    subscription: Subscription,
  ): string | null {
    const prompts: Record<EnhanceCommand, string> = {
      enhance: enhancePromptSystemInstruction,
      grammar: grammarPromptSystemInstruction,
      task: decompressString(subscription.taskInstructions) ?? '',
    };

    const systemPrompt = prompts[cmd];
    return systemPrompt || null;
  }

  function getModelForCommand(cmd: EnhanceCommand): string {
    return cmd === 'task' ? 'gpt-5.1' : 'gpt-4o-mini';
  }

  async function runEnhancementModel(
    logger: Logger,
    text: string,
    cmd: EnhanceCommand,
    subscription: Subscription,
    onDelta?: (delta: string) => void,
  ): Promise<{ rawResponse: string; usage?: CompletionUsage; model: string } | null> {
    const trimmed = text.trim();

    if (!config.openaiApiKey) {
      logger.warn('OPENAI_API_KEY is not set; returning null from runEnhancementModel.');
      return null;
    }

    const systemPrompt = getSystemPromptForCommand(cmd, subscription);

    if (!systemPrompt) {
      logger.error(`No system prompt found for command: ${cmd}`);
      return null;
    }

    const finalSystemPrompt = `${systemPrompt}\n${OUTPUT_FORMAT_INSTRUCTION}`;
    const model = getModelForCommand(cmd);

    const stream = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user', content: trimmed },
      ],
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
    });

    let rawResponse = '';
    let usage: CompletionUsage | undefined;

    for await (const part of stream as any) {
      const delta = part.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        rawResponse += delta;
        if (onDelta) {
          onDelta(delta);
        }
      }
      if (part.usage) {
        usage = part.usage;
      }
    }

    return { rawResponse, usage, model };
  }

  async function enhanceText(
    logger: Logger,
    text: string,
    cmd: EnhanceCommand,
    subscription: Subscription,
  ): Promise<string> {
    const trimmed = text.trim();

    try {
      const result = await runEnhancementModel(logger, trimmed, cmd, subscription);

      if (!result) {
        return trimmed;
      }

      const { rawResponse, usage, model } = result;

      // Record token usage for this subscription and model, if usage
      // data is available and we know which subscription made the call.
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
      const enhanced = rawResponse.trim();

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

  async function streamEnhanceResponse(
    res: Response<any, AuthLocals>,
    text: string,
    cmd: EnhanceCommand,
  ): Promise<void> {
    const { logger, subscription } = res.locals;
    const trimmed = text.trim();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    (res as any).flushHeaders?.();

    try {
      const result = await runEnhancementModel(logger, trimmed, cmd, subscription, (delta) => {
        res.write(delta);
      });

      if (!result) {
        // Fall back to returning the original text once.
        res.write(trimmed);
        res.end();
        return;
      }

      const { usage, model } = result;

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
          logger.error('Failed to record subscription usage metrics during stream.', {
            error: err,
            subscriptionId: subscription.id,
          });
        }
      }

      res.end();
    } catch (err) {
      logger.error('Error streaming enhance response.', {
        error: err,
        command: cmd,
      });

      try {
        res.end();
      } catch {
        // ignore secondary errors when ending stream
      }
    }
  }

  function makeEnhanceHandler(cmd: EnhanceCommand) {
    return async (req: Request, res: Response<any, AuthLocals>) => {
      const { logger, subscription } = res.locals;
      try {
        const body = enhanceRequestSchema.parse(req.body);
        const wantsStream = req.header('x-omnikey-stream') === 'true';

        if (wantsStream) {
          await streamEnhanceResponse(res, body.text, cmd);
          return;
        }

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
