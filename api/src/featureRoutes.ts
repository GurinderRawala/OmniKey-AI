import express, { NextFunction, Request, Response } from 'express';
import { Logger } from 'winston';
import zod from 'zod';
import { EnhanceCommand, OmniKeyError } from './types';
import {
  enhancePromptSystemInstruction,
  grammarPromptSystemInstruction,
  OMNIKEY_DIRECTIVE_SYSTEM_INSTRUCTION,
  OUTPUT_FORMAT_INSTRUCTION,
  TASK_OUTPUT_FORMAT_INSTRUCTION,
  taskPromptSystemInstruction,
} from './prompts';
import { config } from './config';
import { AuthLocals, authMiddleware } from './authMiddleware';
import { Subscription } from './models/subscription';
import { decompressString } from './compression';
import { SubscriptionTaskTemplate } from './models/subscriptionTaskTemplate';
import { aiClient, AIMessage, getFixedHelperModel } from './ai-client';
import { recordTokenUsage, UsageMode } from './usageRecorder';
import { getAgentSettings, selectedAgentModelForProvider } from './agentSettingsStore';

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

export type OmniKeyDirective = {
  instructions: string;
  context: string;
};

type FeatureLocals = AuthLocals & {
  omniKeyDirective?: OmniKeyDirective;
};

const OMNIKEY_DIRECTIVE_PATTERN = /(?:^|(?<=\s))@omnikeyai\b(?!\.)\s*:?\s*/i;

/**
 * Detects the one-shot @omnikeyai mode before any feature-specific handler runs.
 * The handler can then bypass its shortcut prompt and execute only the directive.
 */
export function omniKeyDirectiveMiddleware(
  req: Request,
  res: Response<any, FeatureLocals>,
  next: NextFunction,
): void {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const match = OMNIKEY_DIRECTIVE_PATTERN.exec(text);

  if (match) {
    const instructions = text.slice(match.index + match[0].length).trim();
    if (instructions) {
      res.locals.omniKeyDirective = {
        instructions,
        context: text.slice(0, match.index).trim(),
      };
    }
  }

  next();
}

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

async function getModelForCommand(cmd: EnhanceCommand): Promise<string> {
  // Prompt enhancement and grammar are latency/cost-sensitive helpers, not
  // agent turns. Keep them pinned to cheap provider-specific models so custom
  // or expensive agent model selections never affect keyboard enhancement.
  if (cmd === 'enhance' || cmd === 'grammar') {
    return getFixedHelperModel(config.aiProvider);
  }

  // 'task' is the custom-task command and should follow the same DB-backed
  // provider model selected for OmniAgent turns.
  const settings = await getAgentSettings();
  return selectedAgentModelForProvider(settings, config.aiProvider);
}

function usageModeForCommand(cmd: EnhanceCommand): UsageMode {
  return cmd === 'task' ? 'custom-task' : cmd;
}

export function createMessagesParams(
  cmd: EnhanceCommand,
  input: string,
  prompt: string,
  directive?: OmniKeyDirective,
): AIMessage[] {
  if (directive) {
    return [
      {
        role: 'system',
        content: [OMNIKEY_DIRECTIVE_SYSTEM_INSTRUCTION, TASK_OUTPUT_FORMAT_INSTRUCTION].join('\n'),
      },
      {
        role: 'user',
        content: `<omnikeyai_directive>\n${directive.instructions}\n</omnikeyai_directive>\n<context>\n${directive.context}\n</context>`,
      },
    ];
  }

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
  directive?: OmniKeyDirective,
): Promise<{ rawResponse: string; usage?: CompletionUsage; model: string } | OmniKeyError | null> {
  const trimmed = text.trim();

  // Directive mode must not load or apply the shortcut's own prompt. It uses
  // the smart model because it executes a request rather than rewriting text.
  const prompt = directive ? '' : await getPromptForCommand(logger, cmd, subscription);

  if (!directive && !prompt) {
    logger.error(`No system prompt found for command: ${cmd}`);
    return new OmniKeyError(`No system prompt found for command: ${cmd}`, 404);
  }

  const model = await getModelForCommand(directive ? 'task' : cmd);
  const messages = createMessagesParams(cmd, trimmed, prompt ?? '', directive);

  let rawResponse = '';
  let usage: CompletionUsage | undefined;

  // Smart-tier models (used by the custom-task command) include OpenAI's
  // GPT-5 family, which rejects any non-default `temperature`. Even on
  // providers where the smart model still accepts it (Gemini, Anthropic),
  // omitting `temperature` keeps the request shape uniform across providers
  // and lets each model use its own tuned default. The fast-tier models used
  // by `enhance` and `grammar` keep the previous 0.3 default.
  const completionOptions = cmd === 'task' || directive ? {} : { temperature: 0.3 };
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
  directive?: OmniKeyDirective,
): Promise<string | OmniKeyError> {
  const trimmed = text.trim();

  try {
    const result = await runEnhancementModel(
      logger,
      trimmed,
      cmd,
      subscription,
      undefined,
      directive,
    );

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
  res: Response<any, FeatureLocals>,
  text: string,
  cmd: EnhanceCommand,
  directive?: OmniKeyDirective,
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
    const result = await runEnhancementModel(
      logger,
      trimmed,
      cmd,
      subscription,
      (delta) => {
        if (!delta) return;
        ensureHeadersSent();
        res.write(delta);
      },
      directive,
    );

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
  return async (req: Request, res: Response<any, FeatureLocals>) => {
    const { logger, subscription } = res.locals;
    try {
      const body = enhanceRequestSchema.parse(req.body);
      const wantsStream = req.header('x-omnikey-stream') === 'true';

      if (wantsStream) {
        await streamEnhanceResponse(res, body.text, cmd, res.locals.omniKeyDirective);
        return;
      }

      const result = await enhanceText(
        logger,
        body.text,
        cmd,
        subscription,
        res.locals.omniKeyDirective,
      );

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

  // Authentication and directive detection run consistently before every
  // keyboard-shortcut feature route.
  router.use(authMiddleware, omniKeyDirectiveMiddleware);

  router.post('/enhance', makeEnhanceHandler('enhance'));

  router.post('/grammar', makeEnhanceHandler('grammar'));

  router.post('/custom-task', makeEnhanceHandler('task'));

  return router;
}
