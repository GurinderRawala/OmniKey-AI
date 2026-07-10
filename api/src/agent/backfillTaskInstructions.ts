/**
 * One-shot backfill for the AgentSession columns `task_instruction_id` and
 * `task_instruction_heading` (introduced in the "locked task instructions"
 * change).
 *
 * WHY
 * ---
 * Sessions created BEFORE those columns existed have both fields NULL, so
 * the desktop composer can't show the locked task-instruction chip for
 * them. This module inspects each such session's persisted history for a
 * `<stored_instructions>` block, matches its body against the owning
 * subscription's task templates, and — on a match — writes the template's
 * id + heading onto the session row.
 *
 * SAFETY
 * ------
 * - Only touches rows where BOTH new columns are NULL. Already-backfilled
 *   sessions (and new sessions created after the schema change) are
 *   skipped, so re-running is a no-op.
 * - Sessions with no `<stored_instructions>` block, or whose stored body
 *   no longer matches any live template, are left NULL. The composer
 *   falls back to "No instruction" for those; nothing regresses.
 * - Wrapped in a `system_meta` sentinel so the scan runs once per
 *   deployment, not on every boot. If the caller ever needs to force a
 *   rerun (e.g. after fixing a bug in the extractor) they can DELETE the
 *   `agent_sessions.task_instructions.backfilled_at` row.
 * - Errors on individual sessions are logged and skipped rather than
 *   aborting the whole batch — a single corrupt historyJson must not
 *   prevent server startup.
 */

import { QueryTypes } from 'sequelize';
import { Logger } from 'winston';
import { sequelize } from '../db';
import { AgentSession } from '../models/agentSession';
import { SubscriptionTaskTemplate } from '../models/subscriptionTaskTemplate';
import { decompressString } from '../compression';

const BACKFILL_META_KEY = 'agent_sessions.task_instructions.backfilled_at';

// Matches the exact literal the agent server writes when creating a new
// session (see agentServer.ts). The instruction body sits between the
// first `"""` and the next `"""` inside a `<stored_instructions>` block,
// following a `# Stored Instructions` header. Keeping the anchors tight
// avoids matching stray quotes elsewhere in the message.
const STORED_INSTRUCTIONS_BODY_RE =
  /<stored_instructions>[\s\S]*?"""\s*\n([\s\S]*?)\n"""[\s\S]*?<\/stored_instructions>/i;

interface HistoryEntry {
  role: string;
  content: unknown;
}

/**
 * Ensure the tiny `system_meta` table used to record one-shot migration /
 * backfill markers exists. Idempotent and cheap (single CREATE IF NOT
 * EXISTS). Kept dialect-neutral so the same DDL works on SQLite and
 * Postgres.
 */
async function ensureSystemMetaTable(): Promise<void> {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS system_meta (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT
    )
  `);
}

async function readMeta(key: string): Promise<string | null> {
  const rows = (await sequelize.query(
    'SELECT value FROM system_meta WHERE key = :key',
    { replacements: { key }, type: QueryTypes.SELECT },
  )) as Array<{ value: string | null }>;
  return rows.length ? rows[0].value : null;
}

async function writeMeta(key: string, value: string): Promise<void> {
  // Use two statements instead of dialect-specific UPSERT so this works
  // identically on SQLite and Postgres. The race window is fine — the
  // backfill runs on startup under a single Node process.
  const existing = await readMeta(key);
  if (existing !== null) {
    await sequelize.query('UPDATE system_meta SET value = :value WHERE key = :key', {
      replacements: { key, value },
    });
  } else {
    await sequelize.query('INSERT INTO system_meta (key, value) VALUES (:key, :value)', {
      replacements: { key, value },
    });
  }
}

/**
 * Extract the raw instruction body from a session's persisted history,
 * or return null if no `<stored_instructions>` block is present.
 *
 * Only USER-role entries are inspected — that's where the agent server
 * writes the block. Assistant / system entries are ignored so a chance
 * mention of the tag in a final answer never poisons the match.
 */
function extractStoredInstructionsBody(historyJson: string): string | null {
  let history: HistoryEntry[];
  try {
    history = JSON.parse(historyJson) as HistoryEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(history)) return null;

  for (const entry of history) {
    if (entry.role !== 'user') continue;
    if (typeof entry.content !== 'string') continue;
    const match = entry.content.match(STORED_INSTRUCTIONS_BODY_RE);
    if (match) return match[1].trim();
  }
  return null;
}

interface TemplateCandidate {
  id: string;
  heading: string;
  instructions: string; // decompressed, trimmed
}

/**
 * Load every task template for a subscription with its instructions
 * decompressed and trimmed once — the caller then does string-equality
 * matching against session bodies. Cached per subscription so the batch
 * doesn't re-decompress the same template N times.
 */
async function loadTemplatesForSubscription(
  subscriptionId: string,
  cache: Map<string, TemplateCandidate[]>,
): Promise<TemplateCandidate[]> {
  const cached = cache.get(subscriptionId);
  if (cached) return cached;

  const rows = await SubscriptionTaskTemplate.findAll({
    where: { subscriptionId },
    attributes: ['id', 'heading', 'instructions'],
  });

  const list: TemplateCandidate[] = [];
  for (const row of rows) {
    const decompressed = decompressString(row.instructions);
    if (!decompressed) continue;
    list.push({
      id: row.id,
      heading: row.heading,
      instructions: decompressed.trim(),
    });
  }

  cache.set(subscriptionId, list);
  return list;
}

/**
 * Run the backfill exactly once per deployment. Returns quietly if the
 * marker row already exists.
 */
export async function backfillSessionTaskInstructions(logger: Logger): Promise<void> {
  try {
    await ensureSystemMetaTable();
  } catch (err) {
    logger.error('backfillSessionTaskInstructions: failed to ensure system_meta table', {
      error: err,
    });
    return;
  }

  const alreadyRun = await readMeta(BACKFILL_META_KEY).catch(() => null);
  if (alreadyRun) {
    logger.debug('backfillSessionTaskInstructions: already completed', { at: alreadyRun });
    return;
  }

  const started = Date.now();
  logger.info('backfillSessionTaskInstructions: starting one-time backfill');

  // Only load candidates — rows with both new columns still NULL. Rely on
  // Sequelize's null-safe equality (`IS NULL`) rather than raw SQL so the
  // same code works across dialects.
  let candidates: AgentSession[];
  try {
    candidates = await AgentSession.findAll({
      where: {
        taskInstructionId: null,
        taskInstructionHeading: null,
      },
      attributes: ['id', 'subscriptionId', 'historyJson'],
    });
  } catch (err) {
    logger.error('backfillSessionTaskInstructions: failed to enumerate candidate sessions', {
      error: err,
    });
    return;
  }

  if (candidates.length === 0) {
    logger.info('backfillSessionTaskInstructions: no candidate sessions; nothing to do');
    await writeMeta(BACKFILL_META_KEY, new Date().toISOString()).catch((err) =>
      logger.error('backfillSessionTaskInstructions: failed to record completion marker', {
        error: err,
      }),
    );
    return;
  }

  const templateCache = new Map<string, TemplateCandidate[]>();
  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of candidates) {
    try {
      const body = extractStoredInstructionsBody(session.historyJson || '');
      if (body === null) {
        // No stored_instructions block at all — session was started with
        // "No instruction" configured, so there is nothing to lock.
        skipped += 1;
        continue;
      }

      const templates = await loadTemplatesForSubscription(session.subscriptionId, templateCache);
      const trimmedBody = body.trim();
      const hit = templates.find((t) => t.instructions === trimmedBody);
      if (!hit) {
        unmatched += 1;
        continue;
      }

      await AgentSession.update(
        {
          taskInstructionId: hit.id,
          taskInstructionHeading: hit.heading,
        },
        { where: { id: session.id } },
      );
      matched += 1;
    } catch (err) {
      errors += 1;
      logger.error('backfillSessionTaskInstructions: session update failed', {
        sessionId: session.id,
        error: err,
      });
    }
  }

  await writeMeta(BACKFILL_META_KEY, new Date().toISOString()).catch((err) =>
    logger.error('backfillSessionTaskInstructions: failed to record completion marker', {
      error: err,
    }),
  );

  logger.info('backfillSessionTaskInstructions: done', {
    candidates: candidates.length,
    matched,
    unmatched,
    skipped,
    errors,
    durationMs: Date.now() - started,
  });
}
