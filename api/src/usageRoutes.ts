import express from 'express';
import { Op } from 'sequelize';
import { authMiddleware } from './authMiddleware';
import { getAgentSettings } from './agentSettingsStore';
import { AgentSession } from './models/agentSession';
import { SubscriptionUsage } from './models/subscriptionUsage';

/**
 * Token-only usage metrics.
 *
 * Cost estimation was removed from this endpoint: the per-model price table it
 * relied on had to be hand-maintained, drifted from real provider pricing, and
 * produced figures that could not be reconciled with provider invoices. The
 * endpoint now reports only values derived directly from recorded token counts.
 */

type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
};

type UsageRow = {
  model: string;
  provider: string;
  sessionId?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: Date;
};

type UsageBucket = UsageTotals & {
  key: string;
  label: string;
};

type AgentSessionSummary = {
  id: string;
  title: string;
  turns: number;
  lastActiveAt: Date;
};

function normalizeProvider(provider: string | null | undefined): string {
  return provider && provider.trim() ? provider.trim() : 'unknown';
}

function normalizeModel(model: string | null | undefined): string {
  return model && model.trim() ? model.trim() : 'unknown';
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

function modelLabel(model: string): string {
  return model === 'unknown' ? 'Unknown Model' : model;
}

function emptyTotals(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

function summarizeRows(rows: UsageRow[]): UsageTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.promptTokens += row.promptTokens;
    totals.completionTokens += row.completionTokens;
    totals.totalTokens += row.totalTokens;
    totals.requests += 1;
  }
  return totals;
}

function emptyBucket(key: string, label: string): UsageBucket {
  return { key, label, ...emptyTotals() };
}

function addToBucket(bucket: UsageBucket, row: UsageRow): void {
  bucket.promptTokens += row.promptTokens;
  bucket.completionTokens += row.completionTokens;
  bucket.totalTokens += row.totalTokens;
  bucket.requests += 1;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
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

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function aggregateBy(
  rows: UsageRow[],
  keyFor: (row: UsageRow) => string,
  labelFor: (key: string) => string,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  for (const row of rows) {
    const key = keyFor(row);
    const bucket = map.get(key) ?? emptyBucket(key, labelFor(key));
    addToBucket(bucket, row);
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildDaily(rows: UsageRow[], from: Date | null, to: Date): UsageBucket[] {
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
    addToBucket(bucket, row);
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function buildRecentSessions(
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

  return sessions
    .filter((session) => totalsBySession.has(session.id))
    .slice(0, 5)
    .map((session) => ({
      id: session.id,
      title: session.title || 'Untitled Session',
      turns: Number(session.turns) || 0,
      totalTokens: totalsBySession.get(session.id) ?? 0,
      lastActiveAt: session.lastActiveAt,
    }));
}

function parseRange(query: express.Request['query']): {
  label: string;
  from: Date | null;
  to: Date;
  days: number;
} {
  const now = new Date();
  const to = parseDateValue(query.to) ?? now;
  const explicitFrom = parseDateValue(query.from);
  const range = typeof query.range === 'string' ? query.range : '30d';

  if (explicitFrom) {
    return { label: 'Custom', from: explicitFrom, to, days: daysBetween(explicitFrom, to) };
  }

  if (range === 'all') {
    // Day count for "all time" is derived from the rows themselves so the
    // daily average is not diluted by days before the first recorded call.
    return { label: 'All time', from: null, to, days: 0 };
  }

  if (range === 'month') {
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    return { label: 'This month', from, to, days: daysBetween(from, to) };
  }

  const match = range.match(/^(\d+)d$/);
  const days = match ? Math.max(1, Math.min(365, Number(match[1]))) : 30;
  return { label: `Last ${days} days`, from: addDays(to, -days), to, days };
}

function parseProviderFilter(query: express.Request['query']): string | null {
  if (typeof query.provider !== 'string') return null;
  const provider = normalizeProvider(query.provider);
  return provider === 'all' ? null : provider;
}

function buildWhere(
  subscriptionId: string,
  from: Date | null,
  to: Date,
  provider: string | null,
): Record<string, unknown> {
  const where: Record<string, unknown> = { subscriptionId };
  where.createdAt = from ? { [Op.gte]: from, [Op.lt]: to } : { [Op.lt]: to };
  if (provider) where.provider = provider;
  return where;
}

function toUsageRows(rawRows: SubscriptionUsage[]): UsageRow[] {
  return rawRows.map((row) => ({
    model: normalizeModel(row.model),
    provider: normalizeProvider(row.provider),
    sessionId: row.sessionId ?? null,
    promptTokens: Number(row.promptTokens) || 0,
    completionTokens: Number(row.completionTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
    createdAt: row.createdAt,
  }));
}

/**
 * Days used as the divisor for the daily average. A bounded range uses its own
 * length; "all time" falls back to the number of distinct days that actually
 * have recorded usage so a single old call does not flatten the average.
 */
function countedDays(rows: UsageRow[], rangeDays: number): number {
  if (rangeDays > 0) return rangeDays;
  const distinctDays = new Set(rows.map((row) => dayKey(startOfDay(row.createdAt)))).size;
  return Math.max(1, distinctDays);
}

export function createUsageRouter(): express.Router {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    const { subscription, logger: log } = res.locals;
    const range = parseRange(req.query);
    const providerFilter = parseProviderFilter(req.query);

    try {
      const [agentSettings, rawRows, recentSessionRows] = await Promise.all([
        getAgentSettings(),
        SubscriptionUsage.findAll({
          where: buildWhere(subscription.id, range.from, range.to, providerFilter),
          attributes: [
            'model',
            'provider',
            'sessionId',
            'promptTokens',
            'completionTokens',
            'totalTokens',
            'createdAt',
          ],
          order: [['createdAt', 'ASC']],
        }),
        AgentSession.findAll({
          where: { subscriptionId: subscription.id, totalTokensUsed: { [Op.gt]: 0 } },
          attributes: ['id', 'title', 'turns', 'lastActiveAt'],
          order: [['last_active_at', 'DESC']],
          limit: 200,
        }),
      ]);

      const rows = toUsageRows(rawRows);
      const totals = summarizeRows(rows);
      const days = countedDays(rows, range.days);
      const daily = buildDaily(rows, range.from, range.to);

      res.json({
        recordingEnabled: agentSettings.usageRecordingEnabled,
        generatedAt: new Date().toISOString(),
        range: {
          label: range.label,
          from: range.from?.toISOString() ?? null,
          to: range.to.toISOString(),
          days,
        },
        provider: {
          provider: providerFilter ?? 'all',
          providerLabel: providerFilter ? providerLabel(providerFilter) : 'All Providers',
        },
        totals,
        estimates: {
          averageDailyTokens: totals.totalTokens / days,
        },
        byProvider: aggregateBy(rows, (row) => row.provider, providerLabel),
        byModel: aggregateBy(rows, (row) => row.model, modelLabel),
        daily,
        recentSessions: buildRecentSessions(rows, recentSessionRows as AgentSessionSummary[]),
      });
    } catch (err) {
      log.error('Failed to build usage metrics.', { error: err });
      res.status(500).json({ error: 'Failed to build usage metrics.' });
    }
  });

  return router;
}
