import type { Logger } from 'winston';
import { config } from '../../config';
import { logger } from '../../logger';
import {
  aiClient,
  AIMessage,
  AITool,
  AICompletionResult,
  CompletionOptions,
} from '../../ai-client';
import { pushToSessionHistory } from '../utils';
import { isInjectedUserPrompt } from '../injectedUserPrompts';
import type { SessionState } from '../types';
import { persistSessionToDB } from './sessionStore';
import { isContextLengthError, pruneHistoryForContextLimit } from './contextPruning';
import { buildTrimmedHistoryForRequest, ensureSessionMemory } from './sessionMemory';

// Upper bound on prune-and-retry cycles per completion. Each cycle removes one
// unit (or compacts one message), so 12 is plenty to claw back from an overflow
// while still terminating if the history somehow cannot be shrunk enough.
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 12;
const MAX_OUTPUT_LENGTH_RECOVERY_ATTEMPTS = 3;

export const OUTPUT_LENGTH_FAILURE_MESSAGE =
  'The agent hit the output limit repeatedly while trying to recover. The work so far has been saved, and your next message can continue from that checkpoint.';

function createOutputLengthRecoveryDirective(attempt: number): string {
  return [
    'Your previous response exceeded the output length limit and was cut off.',
    '',
    'Do not repeat or continue the truncated response.',
    'Continue the task from the conversation and tool results already available.',
    attempt > 1
      ? 'This is a repeated output-length recovery attempt, so choose a smaller next step.'
      : null,
    '',
    'Respond immediately with exactly one of:',
    '- a tool call, if you need to keep working',
    '- <final_answer>...</final_answer>, if you have enough information to conclude',
    'Keep any final answer concise. No plain text. No malformed partial output.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function cacheableOptions(
  session: SessionState,
  model: string,
  options: CompletionOptions,
): CompletionOptions {
  const keyBase = `${config.aiProvider}:${model}:${session.subscription?.id ?? 'unknown'}`;
  const promptCacheTtl =
    config.aiProvider === 'openai' && openAIUsesPromptCacheOptions(model) ? '30m' : undefined;
  const promptCacheRetention =
    config.aiProvider === 'openai' && !promptCacheTtl && openAISupportsExtendedPromptCache(model)
      ? '24h'
      : undefined;
  return {
    ...options,
    enablePromptCache: true,
    promptCacheKey:
      options.promptCacheKey ??
      `omnikey-agent-${Buffer.from(keyBase).toString('base64url').slice(0, 48)}`,
    ...(options.promptCacheTtl || !promptCacheTtl ? {} : { promptCacheTtl }),
    ...(options.promptCacheRetention || options.promptCacheTtl || !promptCacheRetention
      ? {}
      : { promptCacheRetention }),
  };
}

function openAIUsesPromptCacheOptions(model: string): boolean {
  const m = model.toLowerCase();
  return /^gpt-5\.(?:[6-9]|\d{2,})/.test(m) || /^gpt-(?:[6-9]|\d{2,})/.test(m);
}

function openAISupportsExtendedPromptCache(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /^gpt-5\.5/.test(m) ||
    /^gpt-5\.4/.test(m) ||
    /^gpt-5\.2/.test(m) ||
    /^gpt-5\.1/.test(m) ||
    /^gpt-5($|-)/.test(m) ||
    /^gpt-4\.1/.test(m)
  );
}

export async function completeWithContextRecovery(
  session: SessionState,
  sessionId: string,
  model: string,
  options: CompletionOptions,
  log: Logger,
  onUsage?: (result: AICompletionResult) => Promise<void>,
): Promise<AICompletionResult> {
  await ensureSessionMemory(session, sessionId, model, log, onUsage);
  let requestHistory = buildTrimmedHistoryForRequest(session, model, sessionId, log);
  const requestOptions = cacheableOptions(session, model, options);

  let attempt = 0;
  for (;;) {
    try {
      return await aiClient.complete(model, requestHistory, requestOptions);
    } catch (err) {
      if (!isContextLengthError(err) || attempt >= MAX_CONTEXT_RECOVERY_ATTEMPTS) throw err;
      attempt++;
      const scratchSession = {
        subscription: session.subscription,
        history: requestHistory,
        turns: session.turns,
      };
      const pruned = pruneHistoryForContextLimit(scratchSession, log);
      requestHistory = scratchSession.history;
      log.warn('Context-length error from provider; pruned history and retrying', {
        sessionId,
        attempt,
        pruned,
        historyLength: session.history.length,
      });
      // Nothing left to prune (only system + final user turn remain) — give up
      // and let the caller surface the error instead of spinning.
      if (!pruned) throw err;
    }
  }
}

export async function recoverOutputLengthResult(
  result: AICompletionResult,
  session: SessionState,
  sessionId: string,
  model: string,
  tools: AITool[],
  log: Logger,
  onUsage: (result: AICompletionResult) => Promise<void>,
): Promise<AICompletionResult | null> {
  let current = result;

  for (
    let attempt = 1;
    current.finish_reason === 'length' && attempt <= MAX_OUTPUT_LENGTH_RECOVERY_ATTEMPTS;
    attempt++
  ) {
    const parsedToolCalls = current.tool_calls?.length
      ? current.tool_calls
      : current.assistantMessage?.tool_calls;
    if (parsedToolCalls?.length) {
      log.warn('Length-truncated response contained complete tool calls; continuing tool loop', {
        sessionId,
        attempt,
        tools: parsedToolCalls.map((tc) => tc.name),
      });
      return {
        ...current,
        finish_reason: 'tool_calls',
        tool_calls: parsedToolCalls,
        assistantMessage: {
          ...current.assistantMessage,
          tool_calls: parsedToolCalls,
        },
      };
    }

    log.warn(
      'Agent response truncated at output limit; injecting continuation recovery directive',
      {
        sessionId,
        attempt,
        contentLength: current.content.length,
      },
    );

    if (current.content.trim()) {
      pushToSessionHistory(logger, session, { role: 'assistant', content: current.content });
    }
    pushToSessionHistory(logger, session, {
      role: 'user',
      content: createOutputLengthRecoveryDirective(attempt),
    });
    await persistSessionToDB(sessionId, session);

    current = await completeWithContextRecovery(
      session,
      sessionId,
      model,
      {
        tools: tools?.length ? tools : undefined,
        temperature: 0.2,
      },
      log,
      onUsage,
    );
    await onUsage(current);
  }

  if (current.finish_reason === 'length') {
    log.warn('Agent output-length recovery exhausted', {
      sessionId,
      contentLength: current.content.length,
    });
    return null;
  }

  return current;
}

export function removeInjectedUserPromptsFromHistory(session: SessionState, log: Logger): number {
  const before = session.history.length;
  session.history = session.history.filter((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return true;
    return !isInjectedUserPrompt(message.content);
  });

  const removed = before - session.history.length;
  if (removed > 0) {
    log.info('Removed stale injected recovery prompts before real user follow-up', { removed });
  }
  return removed;
}
