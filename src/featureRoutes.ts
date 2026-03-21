import express, { Request, Response } from 'express';
import { Logger } from 'winston';
import zod from 'zod';
import { EnhanceCommand, OmniKeyError } from './types';
import {
  enhancePromptSystemInstruction,
  grammarPromptSystemInstruction,
  OUTPUT_FORMAT_INSTRUCTION,
  TASK_OUTPUT_FORMAT_INSTRUCTION,
  taskPromptSystemInstruction,
} from './prompts';
import { config } from './config';
import { AuthLocals, authMiddleware } from './authMiddleware';
import { Subscription } from './models/subscription';
import { SubscriptionUsage } from './models/subscriptionUsage';
import { decompressString } from './compression';
import { SubscriptionTaskTemplate } from './models/subscriptionTaskTemplate';
import { aiClient, AIMessage } from './ai-client';

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

const enhanceRequestSchema = zod.object({
  text: zod.string(),
});

export async function getPromptForCommand(
  logger: Logger,
  cmd: EnhanceCommand,
  subscription: Subscription,
): Promise<string | null> {
  if (cmd === 'enhance') {
    return enhancePromptSystemInstruction;
  }

  if (cmd === 'grammar') {
    return grammarPromptSystemInstruction;
  }

  try {
    const template = await SubscriptionTaskTemplate.findOne({
      where: { subscriptionId: subscription.id, isDefault: true },
      order: [['createdAt', 'ASC']],
    });

    if (template) {
      const decompressed = decompressString(template.instructions);
      if (decompressed) {
        return decompressed;
      }
    }
  } catch (err) {
    logger.error('Error loading subscription task template; falling back to legacy instructions.', {
      error: err,
      subscriptionId: subscription.id,
    });
  }

  return '';
}

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function getModelForCommand(cmd: EnhanceCommand): string {
  const tier = cmd === 'task' ? 'smart' : 'fast';
  const models: Record<string, { fast: string; smart: string }> = {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-5.1' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-4-6' },
  };
  return models[config.aiProvider]?.[tier] ?? 'gpt-4o-mini';
}

function createMessagesParams(cmd: EnhanceCommand, input: string, prompt: string): AIMessage[] {
  if (cmd === 'task') {
    return [
      {
        role: 'system',
        content: [taskPromptSystemInstruction, TASK_OUTPUT_FORMAT_INSTRUCTION].join('\n'),
      },
      {
        role: 'user',
        content: `<user_configured_instructions>
# User-Configured Task Instructions
${prompt}
</user_configured_instructions>
<current_input>
# Current user input for this execution
${input}
</current_input>`,
      },
    ];
  }

  return [
    { role: 'system', content: [prompt, OUTPUT_FORMAT_INSTRUCTION].join('\n') },
    { role: 'user', content: input },
  ];
}

export async function runEnhancementModel(
  logger: Logger,
  text: string,
  cmd: EnhanceCommand,
  subscription: Subscription,
  onDelta?: (delta: string) => void,
): Promise<{ rawResponse: string; usage?: CompletionUsage; model: string } | OmniKeyError | null> {
  const trimmed = text.trim();

  const prompt = await getPromptForCommand(logger, cmd, subscription);

  if (!prompt) {
    logger.error(`No system prompt found for command: ${cmd}`);
    return new OmniKeyError(`No system prompt found for command: ${cmd}`, 404);
  }

  const model = getModelForCommand(cmd);
  const messages = createMessagesParams(cmd, trimmed, prompt);

  let rawResponse = '';
  let usage: CompletionUsage | undefined;

  const result = await aiClient.streamComplete(model, messages, { temperature: 0.3 }, (delta) => {
    rawResponse += delta;
    if (onDelta) onDelta(delta);
  });

  usage = result.usage;

  return { rawResponse, usage, model };
}

async function enhanceText(
  logger: Logger,
  text: string,
  cmd: EnhanceCommand,
  subscription: Subscription,
): Promise<string | OmniKeyError> {
  const trimmed = text.trim();

  try {
    const result = await runEnhancementModel(logger, trimmed, cmd, subscription);

    if (!result || result instanceof OmniKeyError) {
      return result instanceof OmniKeyError ? result : new OmniKeyError('Unknown error', 500);
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

  let headersSent = false;

  const ensureHeadersSent = () => {
    if (!headersSent) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');

      (res as any).flushHeaders?.();
      headersSent = true;
    }
  };

  try {
    const result = await runEnhancementModel(logger, trimmed, cmd, subscription, (delta) => {
      if (!delta) return;
      ensureHeadersSent();
      res.write(delta);
    });

    if (result instanceof OmniKeyError) {
      logger.error('Error during streaming enhancement model execution.', {
        error: result,
        command: cmd,
      });

      if (!headersSent) {
        res.status(result.statusCode ?? 500).json({ error: result.message });
      } else {
        try {
          res.end();
        } catch {
          // ignore secondary errors when ending stream
        }
      }
      return;
    }

    if (!result) {
      // Fall back to returning the original text once.
      ensureHeadersSent();
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

    if (!headersSent) {
      ensureHeadersSent();
    }

    res.end();
  } catch (err) {
    logger.error('Error streaming enhance response.', {
      error: err,
      command: cmd,
    });

    try {
      if (!headersSent) {
        res.status(500).json({ error: 'Internal server error.' });
      } else {
        res.end();
      }
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

      if (result instanceof OmniKeyError) {
        logger.error('Error during enhanceText execution.', {
          error: result,
          command: cmd,
        });
        return res.status(result.statusCode ?? 500).json({ error: result.message });
      }

      return res.json({ result });
    } catch (err) {
      logger.error('Error processing enhance request.', { error: err });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  };
}

export function createFeatureRouter(): express.Router {
  const router = express.Router();

  // Main endpoints used by the macOS app
  router.post('/enhance', authMiddleware, makeEnhanceHandler('enhance'));

  router.post('/grammar', authMiddleware, makeEnhanceHandler('grammar'));

  router.post('/custom-task', authMiddleware, makeEnhanceHandler('task'));

  return router;
}
