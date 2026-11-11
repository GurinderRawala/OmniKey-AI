/**
 * Skills v1 persistence (docs/skills-contract.md).
 *
 * Every operation is owner-scoped by subscription id and reads the database
 * fresh (no caching), so edits are visible to the next resolution. Writes are
 * atomic: revision compare-and-set UPDATE/DELETE, a database UNIQUE index on
 * (subscription_id, normalized_keyword), and a quota guard that is atomic per
 * dialect (single-statement guarded INSERT on SQLite; owner row lock inside a
 * transaction on PostgreSQL).
 *
 * Logging policy: only skill ids, operation names, error class names and
 * driver codes are logged. Never names, keywords, instructions, request
 * bodies, SQL text or raw driver messages (those can contain user data).
 */
import cuid from 'cuid';
import {
  BaseError,
  ForeignKeyConstraintError,
  QueryTypes,
  UniqueConstraintError,
  ValidationError,
  type Sequelize,
} from 'sequelize';
import {
  SKILL_LIMITS,
  SkillError,
  type MatchSkills,
  type ResolveSkillsForInput,
  type SkillDTO,
  type SkillMatchResult,
  type SkillSnapshot,
  type SkillStore,
  type SkillSummary,
  type SkillWarning,
} from './contracts';
import {
  compareCodePoints,
  parseSkillCreate,
  parseSkillPatch,
  validateSkillInstructions,
  validateSkillKeyword,
  validateSkillName,
} from './validation';
import type { SkillModelStatic } from '../models/skill';

export interface SkillStoreLogger {
  warn(message: string, meta?: Record<string, unknown>): unknown;
  error(message: string, meta?: Record<string, unknown>): unknown;
}

export interface SkillStoreDeps {
  /** Undefined when no database is configured; every operation then fails closed (503). */
  sequelize: Sequelize | undefined;
  model: SkillModelStatic;
  logger: SkillStoreLogger;
  now?: () => Date;
  generateId?: () => string;
  /**
   * Upper bound for read operations (list/get/listEnabled). Sequelize's SQLite
   * dialect can hang forever after a failed open; reads then fail closed (503).
   * Writes are not timed out because a late commit would make the result ambiguous.
   */
  readTimeoutMs?: number;
}

export const DEFAULT_SKILL_READ_TIMEOUT_MS = 10_000;

class StoreTimeoutError extends Error {
  constructor() {
    super('Skill store read timed out.');
    this.name = 'SkillStoreTimeout';
  }
}

function isClosedConnectionManagerError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith(
      'ConnectionManager.getConnection was called after the connection manager was closed',
    )
  );
}

export interface SkillCrudStore extends SkillStore {
  list(subscriptionId: string): Promise<SkillSummary[]>;
  get(subscriptionId: string, id: string): Promise<SkillDTO>;
  /** Validates the raw body strictly (unknown fields rejected). */
  create(subscriptionId: string, body: unknown): Promise<SkillDTO>;
  update(
    subscriptionId: string,
    id: string,
    expectedRevision: number,
    body: unknown,
  ): Promise<SkillDTO>;
  remove(subscriptionId: string, id: string, expectedRevision: number): Promise<void>;
}

export const SKILL_ERROR_MESSAGES = Object.freeze({
  VALIDATION_ERROR: 'Invalid skill.',
  UNAUTHENTICATED: 'Authentication required.',
  NOT_FOUND: 'Skill not found.',
  KEYWORD_CONFLICT: 'A skill with this keyword already exists.',
  REVISION_CONFLICT: 'Skill changed. Reload before retrying.',
  REVISION_REQUIRED: 'A revision is required.',
  SKILL_QUOTA_EXCEEDED: `Skill limit reached (${SKILL_LIMITS.saved}). Delete a skill before adding another.`,
  STORE_UNAVAILABLE: 'Skills are temporarily unavailable. Please retry.',
  INTERNAL_ERROR: 'Skills could not be processed.',
  INVALID_SKILL_WARNING: 'A saved skill is invalid and was skipped.',
});

const SUMMARY_ATTRIBUTES = [
  'id',
  'subscriptionId',
  'name',
  'keyword',
  'enabled',
  'revision',
  'createdAt',
  'updatedAt',
] as const;

type Row = Record<string, unknown>;

function rowValues(row: unknown): Row {
  const r = row as { get?: (opts: { plain: true }) => Row };
  return typeof r?.get === 'function' ? r.get({ plain: true }) : (row as Row);
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  return null;
}

function toIso(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** Type-safe DTO serialization; returns null for rows that cannot be represented. */
function toSummary(row: Row): SkillSummary | null {
  const enabled = toBool(row.enabled);
  const createdAt = toIso(row.createdAt);
  const updatedAt = toIso(row.updatedAt);
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.name !== 'string' ||
    typeof row.keyword !== 'string' ||
    enabled === null ||
    !isPositiveRevision(row.revision) ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    keyword: row.keyword,
    enabled,
    revision: row.revision,
    createdAt,
    updatedAt,
  };
}

function toDTO(row: Row): SkillDTO | null {
  const summary = toSummary(row);
  if (!summary || typeof row.instructions !== 'string') return null;
  return { ...summary, instructions: row.instructions };
}

function validationError(fields: Record<string, string>): SkillError {
  return new SkillError(400, 'VALIDATION_ERROR', SKILL_ERROR_MESSAGES.VALIDATION_ERROR, fields);
}

const notFound = () => new SkillError(404, 'NOT_FOUND', SKILL_ERROR_MESSAGES.NOT_FOUND);
const revisionConflict = () =>
  new SkillError(409, 'REVISION_CONFLICT', SKILL_ERROR_MESSAGES.REVISION_CONFLICT);
const quotaExceeded = () =>
  new SkillError(409, 'SKILL_QUOTA_EXCEEDED', SKILL_ERROR_MESSAGES.SKILL_QUOTA_EXCEEDED);
const unauthenticated = () =>
  new SkillError(401, 'UNAUTHENTICATED', SKILL_ERROR_MESSAGES.UNAUTHENTICATED);
export const storeUnavailable = () =>
  new SkillError(503, 'STORE_UNAVAILABLE', SKILL_ERROR_MESSAGES.STORE_UNAVAILABLE);
const internalError = () =>
  new SkillError(500, 'INTERNAL_ERROR', SKILL_ERROR_MESSAGES.INTERNAL_ERROR);

function isKeywordUniqueViolation(err: UniqueConstraintError, model: SkillModelStatic): boolean {
  // SQLite reports `fields` as a column array; PostgreSQL as a column->value object.
  const raw: unknown = err.fields;
  const fields = Array.isArray(raw)
    ? raw.map(String)
    : raw && typeof raw === 'object'
      ? Object.keys(raw)
      : [];
  const constraint = (err as unknown as { original?: { constraint?: unknown } }).original
    ?.constraint;
  const uniqueIndexNames = (model.options.indexes ?? [])
    .filter((index) => index.unique && index.name)
    .map((index) => index.name);
  return (
    fields.includes('normalized_keyword') ||
    fields.includes('normalizedKeyword') ||
    (typeof constraint === 'string' && uniqueIndexNames.includes(constraint))
  );
}

/** Safe diagnostic metadata: class name and driver code only. */
export function safeErrorMeta(err: unknown): Record<string, unknown> {
  const e = err as { name?: unknown; original?: { code?: unknown }; parent?: { code?: unknown } };
  const code = e?.original?.code ?? e?.parent?.code;
  return {
    errorName: typeof e?.name === 'string' ? e.name : typeof err,
    ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
  };
}

export function createSkillStore(deps: SkillStoreDeps): SkillCrudStore {
  const { model, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => cuid());

  function mapError(operation: string, err: unknown): SkillError {
    if (err instanceof SkillError) return err;
    if (err instanceof UniqueConstraintError && isKeywordUniqueViolation(err, model)) {
      return new SkillError(409, 'KEYWORD_CONFLICT', SKILL_ERROR_MESSAGES.KEYWORD_CONFLICT, {
        keyword: SKILL_ERROR_MESSAGES.KEYWORD_CONFLICT,
      });
    }
    if (err instanceof ForeignKeyConstraintError) {
      // The only foreign key is the owning subscription.
      logger.warn('Skill owner no longer exists.', { operation });
      return unauthenticated();
    }
    if (
      (err instanceof BaseError && !(err instanceof ValidationError)) ||
      err instanceof StoreTimeoutError ||
      isClosedConnectionManagerError(err)
    ) {
      logger.warn('Skill store unavailable.', { operation, ...safeErrorMeta(err) });
      return storeUnavailable();
    }
    logger.error('Skill store operation failed.', { operation, ...safeErrorMeta(err) });
    return internalError();
  }

  const readTimeoutMs = deps.readTimeoutMs ?? DEFAULT_SKILL_READ_TIMEOUT_MS;

  async function withReadTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeoutError()), readTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function run<T>(
    operation: string,
    subscriptionId: string,
    fn: (db: Sequelize) => Promise<T>,
    options: { read?: boolean } = {},
  ): Promise<T> {
    if (typeof subscriptionId !== 'string' || !subscriptionId) throw unauthenticated();
    const db = deps.sequelize;
    if (!db) {
      logger.warn('Skill store unavailable.', { operation, errorName: 'NoDatabase' });
      throw storeUnavailable();
    }
    try {
      return options.read ? await withReadTimeout(fn(db)) : await fn(db);
    } catch (err) {
      throw mapError(operation, err);
    }
  }

  function serializeOrFail(row: Row, operation: string): SkillDTO {
    const dto = toDTO(row);
    if (!dto) {
      logger.warn('Stored skill cannot be serialized.', {
        operation,
        skillId: typeof row.id === 'string' ? row.id : undefined,
      });
      throw internalError();
    }
    return dto;
  }

  async function guardedInsertSqlite(db: Sequelize, values: Row): Promise<void> {
    const qi = db.getQueryInterface();
    const q = (name: string) => qi.quoteIdentifier(name);
    const table = q(String(model.getTableName()));
    const columns: Array<[string, string]> = [
      ['id', 'id'],
      ['subscription_id', 'subscriptionId'],
      ['name', 'name'],
      ['keyword', 'keyword'],
      ['normalized_keyword', 'normalizedKeyword'],
      ['instructions', 'instructions'],
      ['enabled', 'enabled'],
      ['revision', 'revision'],
      ['createdAt', 'createdAt'],
      ['updatedAt', 'updatedAt'],
    ];
    // One statement: SQLite serializes writers, so the COUNT and INSERT are atomic
    // across connections and processes sharing the database file.
    const sql =
      `INSERT INTO ${table} (${columns.map(([c]) => q(c)).join(', ')}) ` +
      `SELECT ${columns.map(([, k]) => `:${k}`).join(', ')} ` +
      `WHERE (SELECT COUNT(*) FROM ${table} WHERE ${q('subscription_id')} = :subscriptionId) < :limit`;
    await db.query(sql, {
      logging: false,
      replacements: { ...values, limit: SKILL_LIMITS.saved },
      type: QueryTypes.INSERT,
    });
  }

  async function lockedInsertPostgres(db: Sequelize, values: Row): Promise<void> {
    await db.transaction({ logging: false }, async (transaction) => {
      // Serialize creates per owner: concurrent creators wait on the owner row,
      // then observe each other's committed rows in the COUNT below.
      const owners = await db.query('SELECT id FROM subscriptions WHERE id = :id FOR UPDATE', {
        logging: false,
        replacements: { id: values.subscriptionId },
        type: QueryTypes.SELECT,
        transaction,
      });
      if (owners.length === 0) throw unauthenticated();
      const count = await model.count({
        logging: false,
        where: { subscriptionId: values.subscriptionId as string },
        transaction,
      });
      if (count >= SKILL_LIMITS.saved) throw quotaExceeded();
      await model.create(values as never, { transaction, silent: true, logging: false });
    });
  }

  const store: SkillCrudStore = {
    list(subscriptionId) {
      return run(
        'list',
        subscriptionId,
        async () => {
          const rows = await model.findAll({
            logging: false,
            where: { subscriptionId },
            attributes: [...SUMMARY_ATTRIBUTES],
          });
          const out: SkillSummary[] = [];
          for (const row of rows) {
            const values = rowValues(row);
            const summary = toSummary(values);
            if (summary) out.push(summary);
            else
              logger.warn('Skipping unserializable stored skill in list.', {
                skillId: typeof values.id === 'string' ? values.id : undefined,
              });
          }
          out.sort((a, b) => compareCodePoints(a.name, b.name) || compareCodePoints(a.id, b.id));
          return out;
        },
        { read: true },
      );
    },

    get(subscriptionId, id) {
      return run(
        'get',
        subscriptionId,
        async () => {
          const row = await model.findOne({ logging: false, where: { id, subscriptionId } });
          if (!row) throw notFound();
          return serializeOrFail(rowValues(row), 'get');
        },
        { read: true },
      );
    },

    create(subscriptionId, body) {
      return run('create', subscriptionId, async (db) => {
        const parsed = parseSkillCreate(body);
        if (!parsed.ok) throw validationError(parsed.fields);
        const timestamp = now();
        const values: Row = {
          id: generateId(),
          subscriptionId,
          ...parsed.value,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        if (db.getDialect() === 'postgres') await lockedInsertPostgres(db, values);
        else await guardedInsertSqlite(db, values);
        const row = await model.findOne({
          logging: false,
          where: { id: values.id as string, subscriptionId },
        });
        if (!row) throw quotaExceeded();
        return serializeOrFail(rowValues(row), 'create');
      });
    },

    update(subscriptionId, id, expectedRevision, body) {
      return run('update', subscriptionId, async () => {
        if (!isPositiveRevision(expectedRevision)) {
          throw new SkillError(400, 'VALIDATION_ERROR', SKILL_ERROR_MESSAGES.VALIDATION_ERROR);
        }
        const parsed = parseSkillPatch(body);
        if (!parsed.ok) throw validationError(parsed.fields);
        const current = await model.findOne({ logging: false, where: { id, subscriptionId } });
        if (!current) throw notFound();
        const currentValues = rowValues(current);
        if (currentValues.revision !== expectedRevision) throw revisionConflict();

        const updatedAt = now();
        const changes: Row = { ...parsed.value, revision: expectedRevision + 1, updatedAt };
        // Compare-and-set on revision: concurrent writers cannot both succeed.
        const [affected] = await model.update(changes, {
          logging: false,
          where: { id, subscriptionId, revision: expectedRevision },
          fields: Object.keys(changes) as never,
          silent: true,
          validate: false,
          hooks: false,
        });
        if (affected !== 1) {
          const stillExists = await model.count({ logging: false, where: { id, subscriptionId } });
          throw stillExists > 0 ? revisionConflict() : notFound();
        }
        // Every mutation bumps the revision, so unchanged fields are exactly `current`.
        return serializeOrFail({ ...currentValues, ...changes }, 'update');
      });
    },

    remove(subscriptionId, id, expectedRevision) {
      return run('delete', subscriptionId, async () => {
        if (!isPositiveRevision(expectedRevision)) {
          throw new SkillError(400, 'VALIDATION_ERROR', SKILL_ERROR_MESSAGES.VALIDATION_ERROR);
        }
        const deleted = await model.destroy({
          logging: false,
          where: { id, subscriptionId, revision: expectedRevision },
        });
        if (deleted === 1) return;
        const stillExists = await model.count({ logging: false, where: { id, subscriptionId } });
        throw stillExists > 0 ? revisionConflict() : notFound();
      });
    },

    listEnabled(subscriptionId) {
      return run(
        'listEnabled',
        subscriptionId,
        async () => {
          const rows = await model.findAll({
            logging: false,
            where: { subscriptionId, enabled: true },
          });
          const matches: SkillSnapshot[] = [];
          const warnings: SkillWarning[] = [];
          for (const row of rows) {
            const values = rowValues(row);
            const skillId = typeof values.id === 'string' && values.id ? values.id : undefined;
            const name = validateSkillName(values.name);
            const keyword = validateSkillKeyword(values.keyword);
            const instructions = validateSkillInstructions(values.instructions);
            const invalid = [
              ...(skillId ? [] : ['id']),
              ...(name.ok ? [] : ['name']),
              ...(keyword.ok ? [] : ['keyword']),
              ...(instructions.ok ? [] : ['instructions']),
              ...(isPositiveRevision(values.revision) ? [] : ['revision']),
            ];
            if (invalid.length > 0 || !skillId || !name.ok || !keyword.ok || !instructions.ok) {
              logger.warn('Skipping invalid stored skill.', { skillId, invalidFields: invalid });
              warnings.push({
                code: 'INVALID_SKILL',
                ...(skillId ? { skillId } : {}),
                message: SKILL_ERROR_MESSAGES.INVALID_SKILL_WARNING,
              });
              continue;
            }
            matches.push(
              Object.freeze({
                id: skillId,
                name: name.value,
                keyword: keyword.value.keyword,
                revision: values.revision as number,
                instructions: instructions.value,
              }),
            );
          }
          matches.sort((a, b) => compareCodePoints(a.id, b.id));
          warnings.sort((a, b) => compareCodePoints(a.skillId ?? '', b.skillId ?? ''));
          return { matches: Object.freeze(matches), warnings: Object.freeze(warnings) };
        },
        { read: true },
      );
    },
  };
  return store;
}

function warningKey(warning: SkillWarning): string {
  return `${warning.code}\u0000${warning.skillId ?? ''}\u0000${warning.message}`;
}

/**
 * Compose a resolver from a store and the S2 matcher: one fresh store read per
 * input, store warnings first, deduplicated. Store/limit failures propagate as
 * SkillError (all-or-nothing, no partial matches).
 */
export function createSkillInputResolver(
  store: SkillStore,
  matchSkills: MatchSkills,
): ResolveSkillsForInput {
  return async (subscriptionId, rawText): Promise<SkillMatchResult> => {
    const stored = await store.listEnabled(subscriptionId);
    const result = matchSkills(rawText, stored.matches);
    const seen = new Set<string>();
    const warnings: SkillWarning[] = [];
    for (const warning of [...stored.warnings, ...result.warnings]) {
      const key = warningKey(warning);
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
    return { matches: result.matches, warnings };
  };
}

let defaultStore: SkillCrudStore | undefined;

/** Lazily-constructed store bound to the shared application database. */
export async function getDefaultSkillStore(): Promise<SkillCrudStore> {
  if (!defaultStore) {
    const [{ sequelize }, { Skill }, { logger }] = await Promise.all([
      import('../db'),
      import('../models/skill'),
      import('../logger'),
    ]);
    defaultStore = createSkillStore({ sequelize, model: Skill, logger });
  }
  return defaultStore;
}
