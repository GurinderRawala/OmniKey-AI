import express from 'express';
import { Op } from 'sequelize';
import { authMiddleware } from './authMiddleware';
import { config } from './config';
import { AgentSession } from './models/agentSession';
import { SubscriptionUsage } from './models/subscriptionUsage';

type UsageBucket = {
  key: string;
  label: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  costUsd: number;
};

type UsageRow = {
  id: string;
  model: string;
  provider: string;
  mode: string;
  sessionId?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: Date;
};

type AgentSessionSummary = {
  id: string;
  title: string;
  turns: number;
  totalTokensUsed: number;
  lastActiveAt: Date;
};

type PricingOptions = {
  overridePricePerTokenUsd?: number;
};

const PRICE_BY_MODEL: Record<string, { input: number; output: number }> = {
  // USD per 1M input/output tokens. Unknown models use DEFAULT_PRICE.
  'gpt-5.5': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'nvidia/nemotron-3-ultra-550b-a55b': { input: 0, output: 0 },
  'nvidia/nemotron-3-super-120b-a12b': { input: 0, output: 0 },
};

const DEFAULT_PRICE = { input: 1, output: 5 };

function normalizeProvider(provider: string | null | undefined): string {
  return provider && provider.trim() ? provider.trim() : 'unknown';
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    case 'nemotron':
      return 'Nemotron';
    case 'unknown':
      return 'Unknown';
    default:
      return (
        provider
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ') || 'Unknown'
      );
  }
}

function normalizeMode(mode: string | null | undefined): string {
  return mode && mode.trim() ? mode.trim() : 'unknown';
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'agent':
      return 'Agent';
    case 'scheduled-agent':
      return 'Scheduled Agent';
    case 'enhance':
      return 'Enhance';
    case 'grammar':
      return 'Grammar';
    case 'custom-task':
      return 'Custom Task';
    default:
      return (
        mode
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ') || 'Unknown'
      );
  }
}

function priceForModel(model: string): { input: number; output: number } {
  return PRICE_BY_MODEL[model] ?? DEFAULT_PRICE;
}

function costFor(
  row: Pick<UsageRow, 'model' | 'promptTokens' | 'completionTokens' | 'totalTokens'>,
  pricing: PricingOptions,
): number {
  if (pricing.overridePricePerTokenUsd !== undefined) {
    return row.totalTokens * pricing.overridePricePerTokenUsd;
  }
  const price = priceForModel(row.model);
  return (
    (row.promptTokens / 1_000_000) * price.input + (row.completionTokens / 1_000_000) * price.output
  );
}

function emptyBucket(key: string, label: string): UsageBucket {
  return {
    key,
    label,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    costUsd: 0,
  };
}

function addToBucket(bucket: UsageBucket, row: UsageRow, pricing: PricingOptions): void {
  bucket.promptTokens += row.promptTokens;
  bucket.completionTokens += row.completionTokens;
  bucket.totalTokens += row.totalTokens;
  bucket.requests += 1;
  bucket.costUsd += costFor(row, pricing);
}

function summarizeRows(rows: UsageRow[], pricing: PricingOptions): UsageBucket {
  const bucket = emptyBucket('total', 'Total');
  for (const row of rows) addToBucket(bucket, row, pricing);
  return bucket;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(start: Date, end: Date): number {
  const ms = Math.max(0, end.getTime() - start.getTime());
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

function parseDateValue(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRange(query: express.Request['query']): {
  label: string;
  from: Date | null;
  to: Date;
  previousFrom: Date | null;
  previousTo: Date | null;
  days: number;
} {
  const now = new Date();
  const to = parseDateValue(query.to) ?? now;
  const explicitFrom = parseDateValue(query.from);
  const range = typeof query.range === 'string' ? query.range : '30d';

  if (explicitFrom) {
    const from = explicitFrom;
    const days = daysBetween(from, to);
    return {
      label: 'Custom',
      from,
      to,
      previousFrom: addDays(from, -days),
      previousTo: from,
      days,
    };
  }

  if (range === 'all') {
    return { label: 'All time', from: null, to, previousFrom: null, previousTo: null, days: 30 };
  }

  if (range === 'month') {
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    const previousFrom = new Date(to.getFullYear(), to.getMonth() - 1, 1);
    const previousTo = from;
    return {
      label: 'This month',
      from,
      to,
      previousFrom,
      previousTo,
      days: daysBetween(from, to),
    };
  }

  const match = range.match(/^(\d+)d$/);
  const days = match ? Math.max(1, Math.min(365, Number(match[1]))) : 30;
  const from = addDays(to, -days);
  return {
    label: `Last ${days} days`,
    from,
    to,
    previousFrom: addDays(from, -days),
    previousTo: from,
    days,
  };
}

function parseProviderFilter(query: express.Request['query']): string | null {
  if (typeof query.provider !== 'string') return null;
  const provider = normalizeProvider(query.provider);
  return provider === 'all' ? null : provider;
}

function parsePricingOptions(query: express.Request['query']): PricingOptions {
  const perTokenRaw =
    typeof query.pricePerTokenUsd === 'string' ? Number(query.pricePerTokenUsd) : NaN;
  if (Number.isFinite(perTokenRaw) && perTokenRaw >= 0) {
    return { overridePricePerTokenUsd: perTokenRaw };
  }

  const perMillionRaw =
    typeof query.pricePerMillionTokensUsd === 'string'
      ? Number(query.pricePerMillionTokensUsd)
      : NaN;
  if (Number.isFinite(perMillionRaw) && perMillionRaw >= 0) {
    return { overridePricePerTokenUsd: perMillionRaw / 1_000_000 };
  }

  return {};
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function aggregateBy(
  rows: UsageRow[],
  keyFor: (row: UsageRow) => string,
  labelFor: (key: string) => string,
  pricing: PricingOptions,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key = keyFor(row);
    const bucket = map.get(key) ?? emptyBucket(key, labelFor(key));
    addToBucket(bucket, row, pricing);
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildDaily(
  rows: UsageRow[],
  from: Date | null,
  to: Date,
  pricing: PricingOptions,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  if (from) {
    for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) {
      const key = dayKey(d);
      map.set(key, emptyBucket(key, key));
    }
  }
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    const bucket = map.get(key) ?? emptyBucket(key, key);
    addToBucket(bucket, row, pricing);
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function buildHourly(rows: UsageRow[], pricing: PricingOptions): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  for (let hour = 0; hour < 24; hour++) {
    const key = String(hour).padStart(2, '0');
    map.set(key, emptyBucket(key, `${key}:00`));
  }
  for (const row of rows) {
    const key = String(row.createdAt.getHours()).padStart(2, '0');
    addToBucket(map.get(key)!, row, pricing);
  }
  return Array.from(map.values());
}

function monthLength(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function buildWhere(subscriptionId: string, from: Date | null, to: Date): Record<string, unknown> {
  const where: Record<string, unknown> = { subscriptionId };
  if (from) {
    where.createdAt = { [Op.gte]: from, [Op.lt]: to };
  } else {
    where.createdAt = { [Op.lt]: to };
  }
  return where;
}

function toUsageRows(rawRows: SubscriptionUsage[]): UsageRow[] {
  return rawRows.map((row) => ({
    id: row.id,
    model: row.model,
    provider: normalizeProvider(row.provider),
    mode: normalizeMode(row.mode),
    sessionId: row.sessionId ?? null,
    promptTokens: Number(row.promptTokens),
    completionTokens: Number(row.completionTokens),
    totalTokens: Number(row.totalTokens),
    createdAt: row.createdAt,
  }));
}

function buildTopThreads(
  rows: UsageRow[],
  sessions: AgentSessionSummary[],
): Array<{
  id: string;
  title: string;
  turns: number;
  totalTokens: number;
  lastActiveAt: Date | string;
}> {
  const totalsBySession = new Map<string, number>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    totalsBySession.set(row.sessionId, (totalsBySession.get(row.sessionId) ?? 0) + row.totalTokens);
  }

  const sessionMeta = new Map(sessions.map((session) => [session.id, session]));
  return Array.from(totalsBySession.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, totalTokens]) => {
      const meta = sessionMeta.get(id);
      return {
        id,
        title: meta?.title ?? 'Untitled Thread',
        turns: meta?.turns ?? 0,
        totalTokens,
        lastActiveAt: meta?.lastActiveAt ?? '',
      };
    });
}

export function createUsageRouter(): express.Router {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    const { subscription, logger: log } = res.locals;
    const range = parseRange(req.query);
    const providerFilter = parseProviderFilter(req.query);
    const pricing = parsePricingOptions(req.query);

    try {
      const monthStart = startOfMonth(range.to);

      const [currentRaw, previousRaw, allTimeRaw, monthToDateRaw, sessions] = await Promise.all([
        SubscriptionUsage.findAll({
          where: buildWhere(subscription.id, range.from, range.to),
          order: [['createdAt', 'ASC']],
        }),
        range.previousFrom && range.previousTo
          ? SubscriptionUsage.findAll({
              where: buildWhere(subscription.id, range.previousFrom, range.previousTo),
            })
          : Promise.resolve([]),
        SubscriptionUsage.findAll({
          where: { subscriptionId: subscription.id },
        }),
        SubscriptionUsage.findAll({
          where: buildWhere(subscription.id, monthStart, range.to),
        }),
        AgentSession.findAll({
          where: { subscriptionId: subscription.id, totalTokensUsed: { [Op.gt]: 0 } },
          attributes: ['id', 'title', 'turns', 'totalTokensUsed', 'lastActiveAt'],
          order: [['total_tokens_used', 'DESC']],
          limit: 500,
        }),
      ]);

      const rows = toUsageRows(currentRaw);
      const previousRows = toUsageRows(previousRaw);
      const allTimeRows = toUsageRows(allTimeRaw);
      const monthToDateRows = toUsageRows(monthToDateRaw);

      const availableProviders = aggregateBy(
        allTimeRows,
        (row) => row.provider,
        providerLabel,
        pricing,
      );
      const filteredRows = providerFilter
        ? rows.filter((row) => row.provider === providerFilter)
        : rows;
      const filteredPreviousRows = providerFilter
        ? previousRows.filter((row) => row.provider === providerFilter)
        : previousRows;
      const filteredAllTimeRows = providerFilter
        ? allTimeRows.filter((row) => row.provider === providerFilter)
        : allTimeRows;
      const filteredMonthToDateRows = providerFilter
        ? monthToDateRows.filter((row) => row.provider === providerFilter)
        : monthToDateRows;

      const totals = summarizeRows(filteredRows, pricing);
      const previousTotals = summarizeRows(filteredPreviousRows, pricing);
      const allTimeTotals = summarizeRows(filteredAllTimeRows, pricing);
      const monthToDateTotals = summarizeRows(filteredMonthToDateRows, pricing);
      const daily = buildDaily(filteredRows, range.from, range.to, pricing);
      const hourly = buildHourly(filteredRows, pricing);
      const byProvider = aggregateBy(filteredRows, (row) => row.provider, providerLabel, pricing);
      const activeDays = range.from
        ? daysBetween(range.from, range.to)
        : Math.max(1, new Set(filteredRows.map((row) => dayKey(row.createdAt))).size || 1);
      const distinctThreads = new Set(filteredRows.map((row) => row.sessionId).filter(Boolean))
        .size;
      const topThreadRows = buildTopThreads(filteredAllTimeRows, sessions as AgentSessionSummary[]);
      const avgTokensPerThread = distinctThreads > 0 ? totals.totalTokens / distinctThreads : 0;
      const avgDailyTokens = totals.totalTokens / activeDays;
      const avgDailyCost = totals.costUsd / activeDays;
      const monthElapsedDays = daysBetween(monthStart, range.to);
      const daysInMonth = monthLength(range.to);
      const monthAverageDailyCost = monthToDateTotals.costUsd / monthElapsedDays;
      const currentMonthProjectedCost = monthAverageDailyCost * daysInMonth;
      const previousDelta =
        previousTotals.totalTokens > 0
          ? (totals.totalTokens - previousTotals.totalTokens) / previousTotals.totalTokens
          : null;

      res.json({
        recordingEnabled: config.usageRecordingEnabled,
        generatedAt: new Date().toISOString(),
        range: {
          label: range.label,
          from: range.from?.toISOString() ?? null,
          to: range.to.toISOString(),
          previousFrom: range.previousFrom?.toISOString() ?? null,
          previousTo: range.previousTo?.toISOString() ?? null,
          days: activeDays,
        },
        pricing: {
          provider: providerFilter ?? 'all',
          providerLabel: providerFilter ? providerLabel(providerFilter) : 'All Providers',
          customPricePerMillionTokensUsd:
            pricing.overridePricePerTokenUsd !== undefined
              ? pricing.overridePricePerTokenUsd * 1_000_000
              : null,
        },
        allTimeTotals,
        totals,
        previousTotals,
        comparison: {
          tokenDeltaRatio: previousDelta,
          tokenDelta: totals.totalTokens - previousTotals.totalTokens,
          costDeltaUsd: totals.costUsd - previousTotals.costUsd,
        },
        estimates: {
          averageDailyTokens: avgDailyTokens,
          averageDailyCostUsd: avgDailyCost,
          monthToDateTokens: monthToDateTotals.totalTokens,
          monthToDateCostUsd: monthToDateTotals.costUsd,
          monthToDateAverageDailyCostUsd: monthAverageDailyCost,
          monthElapsedDays,
          projectedEndOfMonthCostUsd: currentMonthProjectedCost,
          costAssumption:
            pricing.overridePricePerTokenUsd !== undefined
              ? 'Estimated with the custom USD-per-1M-token override.'
              : 'Estimated with built-in USD-per-1M-token rates; unknown models use a conservative default.',
        },
        threads: {
          distinctThreads,
          averageTokensPerThread: avgTokensPerThread,
          topThreads: topThreadRows,
        },
        availableProviders,
        byProvider,
        byMode: aggregateBy(filteredRows, (row) => row.mode, modeLabel, pricing),
        byModel: aggregateBy(
          filteredRows,
          (row) => row.model,
          (model) => model,
          pricing,
        ),
        daily,
        hourly,
        peakHours: hourly
          .filter((bucket) => bucket.totalTokens > 0)
          .sort((a, b) => b.totalTokens - a.totalTokens)
          .slice(0, 3),
        mostUsedFeatures: aggregateBy(filteredRows, (row) => row.mode, modeLabel, pricing)
          .sort((a, b) => b.requests - a.requests)
          .slice(0, 5),
        efficiencyTrend: daily.map((bucket) => ({
          date: bucket.key,
          averageTokensPerRequest: bucket.requests > 0 ? bucket.totalTokens / bucket.requests : 0,
          outputShare: bucket.totalTokens > 0 ? bucket.completionTokens / bucket.totalTokens : 0,
        })),
      });
    } catch (err) {
      log.error('Failed to build usage metrics.', { error: err });
      res.status(500).json({ error: 'Failed to build usage metrics.' });
    }
  });

  return router;
}
