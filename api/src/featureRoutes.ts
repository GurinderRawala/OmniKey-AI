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
import { AIProvider, config } from './config';
import { AuthLocals, authMiddleware } from './authMiddleware';
import { Subscription } from './models/subscription';
import { decompressString } from './compression';
import { SubscriptionTaskTemplate } from './models/subscriptionTaskTemplate';
import { aiClient, AIMessage, getDefaultModel } from './ai-client';
import { recordTokenUsage, UsageMode } from './usageRecorder';

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

/**
 * Snapshot of the subscription's currently-default task template, used when
 * a brand-new agent session is created so the choice becomes tied to that
 * session for its entire lifetime.
 *
 * Both `id` and `heading` may be `null` when the user has no default template
 * configured — in which case the session was started with "No instruction".
 */
export interface TaskTemplateSnapshot {
  id: string | null;
  heading: string | null;
  instructions: string;
}

/**
 * Load the subscription's current default task template AND its identifying
 * metadata in a single query so callers can persist the id + heading
 * alongside the resolved instructions text.
 *
 * Returns `null` when no default template is configured. Failures are logged
 * and treated as "no template" so a transient DB blip never blocks a new
 * agent session from starting.
 */
export async function getDefaultTaskTemplateSnapshot(
  logger: Logger,
  subscription: Subscription,
): Promise<TaskTemplateSnapshot | null> {
  try {
    const template = await SubscriptionTaskTemplate.findOne({
      where: { subscriptionId: subscription.id, isDefault: true },
      order: [['createdAt', 'ASC']],
    });

    if (!template) return null;

    const decompressed = decompressString(template.instructions);
    if (!decompressed) return null;

    return {
      id: template.id,
      heading: template.heading ?? null,
      instructions: decompressed,
    };
  } catch (err) {
    logger.error('Error loading default task template snapshot; treating as "no template".', {
      error: err,
      subscriptionId: subscription.id,
    });
    return null;
  }
}

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

const PROMPT_ENHANCEMENT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-2.5-flash',
  nemotron: 'nvidia/nemotron-3-nano-30b-a3b',
};

function getModelForCommand(cmd: EnhanceCommand): string {
  // Prompt enhancement and grammar are latency/cost-sensitive helpers, not
  // agent turns. Keep them pinned to cheap provider-specific models so custom
  // or expensive agent model selections never affect keyboard enhancement.
  if (cmd === 'enhance' || cmd === 'grammar') {
    return PROMPT_ENHANCEMENT_MODEL_BY_PROVIDER[config.aiProvider];
  }

  // 'task' is the custom-task command and still routes to the smart tier.
  return getDefaultModel(config.aiProvider, 'smart');
}

function usageModeForCommand(cmd: EnhanceCommand): UsageMode {
  return cmd === 'task' ? 'custom-task' : cmd;
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

  // Smart-tier models (used by the custom-task command) include OpenAI's
  // GPT-5 family, which rejects any non-default `temperature`. Even on
  // providers where the smart model still accepts it (Gemini, Anthropic),
  // omitting `temperature` keeps the request shape uniform across providers
  // and lets each model use its own tuned default. The fast-tier models used
  // by `enhance` and `grammar` keep the previous 0.3 default.
  const completionOptions = cmd === 'task' ? {} : { temperature: 0.3 };
  const result = await aiClient.streamComplete(model, messages, completionOptions, (delta) => {
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

    await recordTokenUsage(logger, subscription, usage, model, usageModeForCommand(cmd));
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

    await recordTokenUsage(logger, subscription, usage, model, usageModeForCommand(cmd));

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
