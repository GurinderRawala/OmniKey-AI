import type { Logger } from 'winston';
import { config } from './config';
import { Subscription } from './models/subscription';
import { SubscriptionUsage } from './models/subscriptionUsage';

export type TokenUsagePayload = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
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
  if (!usage || !subscription.id || !config.usageRecordingEnabled) return;

  try {
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
