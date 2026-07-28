import type { Logger } from 'winston';
import { config } from './config';
import { Subscription } from './models/subscription';
import { SubscriptionUsage } from './models/subscriptionUsage';
import { getAgentSettings } from './agentSettingsStore';

export type TokenUsagePayload = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
};

export type UsageMode = 'agent' | 'scheduled-agent' | 'enhance' | 'grammar' | 'custom-task';

export async function recordTokenUsage(
  log: Logger,
  subscription: Subscription,
  usage: TokenUsagePayload | undefined,
  model: string,
  mode: UsageMode,
  sessionId?: string,
): Promise<void> {
  if (!usage || !subscription.id) return;

  try {
    const settings = await getAgentSettings();
    if (!settings.usageRecordingEnabled) return;

    const totalTokens = usage.total_tokens ?? 0;
    await SubscriptionUsage.create({
      subscriptionId: subscription.id,
      model,
      provider: config.aiProvider,
      mode,
      sessionId: sessionId ?? null,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens,
      cachedPromptTokens: usage.cached_tokens ?? 0,
      cacheWritePromptTokens: usage.cache_write_tokens ?? 0,
    });

    await Subscription.increment('totalTokensUsed', {
      by: totalTokens,
      where: { id: subscription.id },
    });
  } catch (err) {
    log.error('Failed to record subscription usage metrics.', {
      error: err,
      subscriptionId: subscription.id,
      mode,
      sessionId,
    });
  }
}
