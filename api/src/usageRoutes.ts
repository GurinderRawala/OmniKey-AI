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

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
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

function parseDateValue(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimeZone(query: express.Request['query']): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const value = typeof query.timeZone === 'string' ? query.timeZone.trim() : '';
  if (!value) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return fallback;
  }
}

function zonedParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDayKeyFromParts(parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function dayKey(date: Date, timeZone: string): string {
  return localDayKeyFromParts(zonedParts(date, timeZone));
}

function parseDayKey(key: string): Pick<ZonedDateParts, 'year' | 'month' | 'day'> {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

function addCalendarDays(key: string, days: number): string {
  const { year, month, day } = parseDayKey(key);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return localDayKeyFromParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

function calendarDaysBetween(startKey: string, endKey: string): number {
  const start = parseDayKey(startKey);
  const end = parseDayKey(endKey);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  return Math.floor((endMs - startMs) / 86_400_000);
}

function zonedDateTimeToUtc(
  parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'> &
    Partial<Pick<ZonedDateParts, 'hour' | 'minute' | 'second'>>,
  timeZone: string,
): Date {
  const target = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let utcMs = targetAsUtc;

  for (let i = 0; i < 3; i++) {
    const actual = zonedParts(new Date(utcMs), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const diff = actualAsUtc - targetAsUtc;
    if (diff === 0) break;
    utcMs -= diff;
  }

  return new Date(utcMs);
}

function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  const shifted = parseDayKey(addCalendarDays(localDayKeyFromParts(parts), days));
  return zonedDateTimeToUtc(
    { ...shifted, hour: parts.hour, minute: parts.minute, second: parts.second },
    timeZone,
  );
}

function localDaySpan(from: Date, to: Date, timeZone: string): number {
  const startKey = dayKey(from, timeZone);
  const endKey = dayKey(to, timeZone);
  return Math.max(1, calendarDaysBetween(startKey, endKey) + 1);
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

function buildDaily(
  rows: UsageRow[],
  from: Date | null,
  to: Date,
  timeZone: string,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  if (from) {
    const endKey = dayKey(to, timeZone);
    for (let key = dayKey(from, timeZone); key <= endKey; key = addCalendarDays(key, 1)) {
      map.set(key, emptyBucket(key, key));
    }
  }
  for (const row of rows) {
    const key = dayKey(row.createdAt, timeZone);
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

function parseRange(
  query: express.Request['query'],
  timeZone: string,
): {
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
    return {
      label: 'Custom',
      from: explicitFrom,
      to,
      days: localDaySpan(explicitFrom, to, timeZone),
    };
  }

  if (range === 'all') {
    // Day count for "all time" is derived from the rows themselves so the
    // daily average is not diluted by days before the first recorded call.
    return { label: 'All time', from: null, to, days: 0 };
  }

  if (range === 'month') {
    const parts = zonedParts(to, timeZone);
    const from = zonedDateTimeToUtc({ year: parts.year, month: parts.month, day: 1 }, timeZone);
    return { label: 'This month', from, to, days: localDaySpan(from, to, timeZone) };
  }

  const match = range.match(/^(\d+)d$/);
  const days = match ? Math.max(1, Math.min(365, Number(match[1]))) : 30;
  return { label: `Last ${days} days`, from: addLocalDays(to, -days, timeZone), to, days };
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
function countedDays(rows: UsageRow[], rangeDays: number, timeZone: string): number {
  if (rangeDays > 0) return rangeDays;
  const distinctDays = new Set(rows.map((row) => dayKey(row.createdAt, timeZone))).size;
  return Math.max(1, distinctDays);
}

export function createUsageRouter(): express.Router {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    const { subscription, logger: log } = res.locals;
    const timeZone = parseTimeZone(req.query);
    const range = parseRange(req.query, timeZone);
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
      const days = countedDays(rows, range.days, timeZone);
      const daily = buildDaily(rows, range.from, range.to, timeZone);

      res.json({
        recordingEnabled: agentSettings.usageRecordingEnabled,
        generatedAt: new Date().toISOString(),
        range: {
          label: range.label,
          from: range.from?.toISOString() ?? null,
          to: range.to.toISOString(),
          days,
          timeZone,
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
