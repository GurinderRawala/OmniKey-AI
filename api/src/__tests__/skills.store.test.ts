import fs from 'fs';
import os from 'os';
import path from 'path';
import { Sequelize } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillError, SKILL_LIMITS } from '../skills/contracts';
import {
  createSkillInputResolver,
  createSkillStore,
  type SkillCrudStore,
} from '../skills/skillStore';

// Config is mocked BEFORE any db/model import so the real db.ts opens only an
// isolated SQLite file inside the per-run temp directory, never ~/.omnikey.
const h = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock('../config', () => ({ config: h.config }));
vi.mock('../logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) },
}));
vi.mock('../agent/defaultSelfHostedSeeds', () => ({
  seedDefaultSelfHostedAgentAssets: async () => {},
  seedDefaultSelfHostedAgentAssetsForSubscription: async () => {},
}));
vi.mock('../agent/backfillTaskInstructions', () => ({
  backfillSessionTaskInstructions: async () => {},
}));

const SECRET = 'TOP-SECRET-INSTRUCTION-BODY-7f3a';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
const logs: unknown[] = [];
const captureLogger = {
  info: (...args: unknown[]) => logs.push(args),
  warn: (...args: unknown[]) => logs.push(args),
  error: (...args: unknown[]) => logs.push(args),
};
const openInstances: Sequelize[] = [];

type Booted = Awaited<ReturnType<typeof boot>>;

async function boot(dbPath: string, options: { withSkill?: boolean } = {}) {
  expect(path.resolve(dbPath).startsWith(path.resolve(os.tmpdir()))).toBe(true);
  vi.resetModules();
  Object.assign(h.config, {
    isSelfHosted: true,
    sqlitePath: dbPath,
    dbLogging: false,
    blockSaas: false,
    databaseUrl: undefined,
    logLevel: 'error',
    isLocal: false,
  });
  const db = await import('../db');
  // Mirror index.ts model registration (all tables touched by migrations).
  await import('../models/appDownload');
  await import('../models/agentSession');
  await import('../models/agentTranscriptMessage');
  await import('../models/scheduledJob');
  await import('../models/mcpServer');
  await import('../models/subscriptionTaskTemplate');
  await import('../models/subscriptionUsage');
  await import('../models/agentSettings');
  const { Subscription } = await import('../models/subscription');
  const { SubscriptionTaskTemplate } = await import('../models/subscriptionTaskTemplate');
  const skillModule = options.withSkill === false ? undefined : await import('../models/skill');
  await db.initDatabase(captureLogger as never);
  openInstances.push(db.sequelize);
  const store = skillModule
    ? createSkillStore({ sequelize: db.sequelize, model: skillModule.Skill, logger: captureLogger })
    : undefined;
  return { sequelize: db.sequelize, Subscription, SubscriptionTaskTemplate, skillModule, store };
}

async function addOwner(b: Booted, id: string) {
  await b.Subscription.create({
    id,
    licenseKey: `key-${id}`,
    email: `${id}@example.test`,
    subscriptionStatus: 'active',
    isSelfHosted: true,
  });
}

async function expectSkillError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillError);
  expect((err as SkillError).status).toBe(status);
  expect((err as SkillError).code).toBe(code);
  return err as SkillError;
}

const body = (keyword: string, extra: Record<string, unknown> = {}) => ({
  name: `Skill ${keyword}`,
  keyword,
  instructions: `${SECRET} for ${keyword}`,
  ...extra,
});

/** A second, independent connection pool to the same database file. */
async function isolatedStore(dbPath: string) {
  const seq = new Sequelize({ dialect: 'sqlite', storage: dbPath, logging: false });
  openInstances.push(seq);
  const { defineSkillModel } = await import('../models/skill');
  const model = defineSkillModel(seq);
  return { seq, store: createSkillStore({ sequelize: seq, model, logger: captureLogger }) };
}

afterAll(async () => {
  // Intentionally broken handles may never settle on close; bound each close.
  for (const instance of openInstances) {
    await Promise.race([
      instance.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // Instruction bodies must never reach routine logs.
  expect(JSON.stringify(logs)).not.toContain(SECRET);
});

describe('skills upgrade and restart (real SQLite via initDatabase)', () => {
  const dbPath = path.join(tmpRoot, 'upgrade.sqlite');

  it('upgrading a pre-Skills database adds an empty skills table without touching existing data', async () => {
    const legacy = await boot(dbPath, { withSkill: false });
    await addOwner(legacy, 'owner-a');
    await legacy.SubscriptionTaskTemplate.create({
      subscriptionId: 'owner-a',
      heading: 'Template',
      instructions: 'Existing template text',
      isDefault: true,
    });
    const { AgentSession } = await import('../models/agentSession');
    await AgentSession.create({
      subscriptionId: 'owner-a',
      title: 'Preserved session',
      historyJson: '[]',
      sessionMemory: 'Preserved memory',
    });
    const dump = async (seq: Sequelize) => ({
      schema: (
        await seq.query(
          "SELECT name, sql FROM sqlite_master WHERE tbl_name != 'skills' ORDER BY name",
        )
      )[0],
      subs: (await seq.query('SELECT * FROM subscriptions ORDER BY id'))[0],
      templates: (await seq.query('SELECT * FROM subscription_task_templates ORDER BY id'))[0],
      sessions: (await seq.query('SELECT * FROM agent_sessions ORDER BY id'))[0],
    });
    const before = await dump(legacy.sequelize);
    expect(
      (await legacy.sequelize.query("SELECT name FROM sqlite_master WHERE name = 'skills'"))[0],
    ).toEqual([]);
    await legacy.sequelize.close();

    const upgraded = await boot(dbPath);
    expect(await dump(upgraded.sequelize)).toEqual(before);
    expect((await upgraded.sequelize.query('SELECT COUNT(*) AS n FROM skills'))[0]).toEqual([
      { n: 0 },
    ]);
    const indexes = (await upgraded.sequelize.query("PRAGMA index_list('skills')"))[0] as Array<{
      name: string;
      unique: number;
    }>;
    const unique = indexes.find((i) => i.name === 'skills_subscription_id_normalized_keyword');
    expect(unique?.unique).toBe(1);
    const cols = (
      await upgraded.sequelize.query(
        "PRAGMA index_info('skills_subscription_id_normalized_keyword')",
      )
    )[0] as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(['subscription_id', 'normalized_keyword']);
    expect(await upgraded.store!.list('owner-a')).toEqual([]);

    const created = await upgraded.store!.create('owner-a', body('restart check'));
    await upgraded.sequelize.close();

    // Restart: re-running initDatabase is idempotent and the record persists.
    const restarted = await boot(dbPath);
    expect(await restarted.store!.get('owner-a', created.id)).toEqual(created);
    expect(await dump(restarted.sequelize)).toEqual(before);
    await restarted.sequelize.close();
  });
});

describe('skill store CRUD (real SQLite)', () => {
  const dbPath = path.join(tmpRoot, 'crud.sqlite');
  let b: Booted;
  let store: SkillCrudStore;

  beforeAll(async () => {
    b = await boot(dbPath);
    store = b.store!;
    for (const id of ['owner-a', 'owner-b', 'owner-q', 'owner-r', 'owner-x']) await addOwner(b, id);
  });

  it('never sends skill SQL or parameters to enabled database logging', async () => {
    const sqlLogs: string[] = [];
    const runtime = b.sequelize as Sequelize & {
      options: { logging: false | ((sql: string) => void) };
    };
    const original = runtime.options.logging;
    runtime.options.logging = (sql: string) => {
      sqlLogs.push(sql);
    };
    try {
      const created = await store.create('owner-a', {
        name: 'Private',
        keyword: 'private-log',
        instructions: 'PRIVATE-INSTRUCTION-SENTINEL',
      });
      await store.get('owner-a', created.id);
      await store.list('owner-a');
      await store.listEnabled('owner-a');
      await store.update('owner-a', created.id, 1, { instructions: 'PRIVATE-UPDATED-SENTINEL' });
      await store.remove('owner-a', created.id, 2);
      expect(sqlLogs).toEqual([]);
    } finally {
      runtime.options.logging = original;
    }
  });

  it('creates, reads, lists, toggles, updates and deletes with revisions', async () => {
    const created = await store.create('owner-a', {
      name: '  Review  ',
      keyword: ' Code Review ',
      instructions: 'Line 1\r\nLine 2\rLine 3\n\tindented  ',
    });
    expect(created).toMatchObject({
      name: 'Review',
      keyword: 'Code Review',
      instructions: 'Line 1\nLine 2\nLine 3\n\tindented  ',
      enabled: true,
      revision: 1,
    });
    expect(Object.keys(created).sort()).toEqual(
      [
        'createdAt',
        'enabled',
        'id',
        'instructions',
        'keyword',
        'name',
        'revision',
        'updatedAt',
      ].sort(),
    );
    expect(created.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(await store.get('owner-a', created.id)).toEqual(created);

    const list = await store.list('owner-a');
    expect(list).toEqual([
      {
        id: created.id,
        name: 'Review',
        keyword: 'Code Review',
        enabled: true,
        revision: 1,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain('Line 1');

    await new Promise((r) => setTimeout(r, 5));
    const disabled = await store.update('owner-a', created.id, 1, { enabled: false });
    expect(disabled).toMatchObject({ enabled: false, revision: 2, name: 'Review' });
    expect(disabled.createdAt).toBe(created.createdAt);
    expect(Date.parse(disabled.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect(await store.get('owner-a', created.id)).toEqual(disabled);

    // No-op patch still increments the revision.
    const same = await store.update('owner-a', created.id, 2, { enabled: false });
    expect(same.revision).toBe(3);

    const edited = await store.update('owner-a', created.id, 3, {
      name: 'Renamed',
      keyword: 'SQL review',
      instructions: 'New\r\nbody',
      enabled: true,
    });
    expect(edited).toMatchObject({
      name: 'Renamed',
      keyword: 'SQL review',
      instructions: 'New\nbody',
      enabled: true,
      revision: 4,
    });
    expect(await store.get('owner-a', created.id)).toEqual(edited);

    await store.remove('owner-a', created.id, 4);
    await expectSkillError(store.get('owner-a', created.id), 404, 'NOT_FOUND');
    await expectSkillError(store.remove('owner-a', created.id, 4), 404, 'NOT_FOUND');
  });

  it('honours enabled:false on create and stores canonical keywords privately', async () => {
    const s = await store.create('owner-a', body('ＣＯＤＥ　Ｘ', { enabled: false }));
    expect(s.enabled).toBe(false);
    expect(s.keyword).toBe('ＣＯＤＥ　Ｘ');
    const [rows] = await b.sequelize.query('SELECT normalized_keyword FROM skills WHERE id = :id', {
      replacements: { id: s.id },
    });
    expect(rows).toEqual([{ normalized_keyword: 'code x' }]);
    expect(Object.keys(s)).not.toContain('normalizedKeyword');
    await store.remove('owner-a', s.id, 1);
  });

  it.each([
    ['non-object body', null, 'body'],
    ['array body', [], 'body'],
    ['unknown field', { ...body('k1'), subscriptionId: 'owner-b' }, 'body'],
    ['immutable field', { ...body('k1'), revision: 5 }, 'body'],
    ['missing instructions', { name: 'a', keyword: 'k1' }, 'instructions'],
    ['blank name', body('k1', { name: '   ' }), 'name'],
    ['NUL in name', body('k1', { name: 'a\u0000b' }), 'name'],
    ['tab in keyword', body('k\t1'), 'keyword'],
    ['newline in name', body('k1', { name: 'a\nb' }), 'name'],
    ['zero-width in name', body('k1', { name: 'a\u200Bb' }), 'name'],
    ['bidi control in keyword', body('k\u202E1'), 'keyword'],
    ['line separator in keyword', body('k\u20281'), 'keyword'],
    ['C1 control in keyword', body('k\u00851'), 'keyword'],
    ['reserved keyword', body('@OmniAgent'), 'keyword'],
    ['fullwidth reserved keyword', body('＠omnikeyai'), 'keyword'],
    ['emoji-only keyword', body('😀🎉'), 'keyword'],
    ['punctuation-only keyword', body('++--'), 'keyword'],
    ['long keyword', body('k'.repeat(81)), 'keyword'],
    ['keyword long after NFKC', body('\uFDFA'.repeat(5)), 'keyword'],
    ['long name', body('k1', { name: 'n'.repeat(81) }), 'name'],
    ['blank instructions', body('k1', { instructions: ' \n\t ' }), 'instructions'],
    ['NUL in instructions', body('k1', { instructions: 'a\u0000' }), 'instructions'],
    ['control in instructions', body('k1', { instructions: 'a\u0007' }), 'instructions'],
    ['too long instructions', body('k1', { instructions: 'x'.repeat(8_001) }), 'instructions'],
    ['lone surrogate', body('k1', { instructions: 'a\uD800' }), 'instructions'],
    ['enabled not boolean', body('k1', { enabled: 'yes' }), 'enabled'],
  ])('rejects %s on create', async (_label, input, field) => {
    const err = await expectSkillError(store.create('owner-a', input), 400, 'VALIDATION_ERROR');
    expect(Object.keys(err.fields ?? {})).toContain(field);
    expect(JSON.stringify(err.fields)).not.toContain(SECRET);
  });

  it('accepts limit edges: 80 code points, 8,000 instructions after CRLF normalization', async () => {
    const astral = '😀'.repeat(79) + 'a';
    const a = await store.create('owner-x', {
      name: '😀'.repeat(80),
      keyword: astral,
      instructions: 'a\r\n'.repeat(4_000),
    });
    expect(a.instructions.length).toBe(8_000);
    const c = await store.create('owner-x', body('c++', { instructions: '😀'.repeat(8_000) }));
    expect([...c.instructions].length).toBe(8_000);
    await store.remove('owner-x', a.id, 1);
    await store.remove('owner-x', c.id, 1);
  });

  it('rejects empty and invalid patches without changing the revision', async () => {
    const s = await store.create('owner-a', body('patch target'));
    await expectSkillError(store.update('owner-a', s.id, 1, {}), 400, 'VALIDATION_ERROR');
    await expectSkillError(store.update('owner-a', s.id, 1, { id: 'x' }), 400, 'VALIDATION_ERROR');
    await expectSkillError(
      store.update('owner-a', s.id, 1, { keyword: '@omniagent' }),
      400,
      'VALIDATION_ERROR',
    );
    expect((await store.get('owner-a', s.id)).revision).toBe(1);
    await store.remove('owner-a', s.id, 1);
  });

  it('enforces canonical keyword uniqueness per owner, including disabled skills', async () => {
    const first = await store.create('owner-a', body('Code  Review', { enabled: false }));
    for (const variant of ['code review', 'ＣＯＤＥ　Review', ' CODE\u00A0REVIEW ']) {
      const err = await expectSkillError(
        store.create('owner-a', body(variant)),
        409,
        'KEYWORD_CONFLICT',
      );
      expect(err.message).not.toContain('review');
    }
    // Different owner may reuse the keyword, isolated.
    const other = await store.create('owner-b', body('code review'));
    expect(other.keyword).toBe('code review');

    const second = await store.create('owner-a', body('another'));
    await expectSkillError(
      store.update('owner-a', second.id, 1, { keyword: 'CODE REVIEW' }),
      409,
      'KEYWORD_CONFLICT',
    );
    expect((await store.get('owner-a', second.id)).revision).toBe(1);
    // Changing case of its own keyword is allowed.
    expect((await store.update('owner-a', first.id, 1, { keyword: 'code review' })).revision).toBe(
      2,
    );
    await store.remove('owner-a', first.id, 2);
    await store.remove('owner-a', second.id, 1);
    await store.remove('owner-b', other.id, 1);
  });

  it('allows exactly one winner in a concurrent duplicate-create race', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => store.create('owner-r', body(i % 2 ? 'RACE' : 'race'))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed.map((f) => (f.reason as SkillError).code)).toEqual(
      Array(5).fill('KEYWORD_CONFLICT'),
    );
    expect(await store.list('owner-r')).toHaveLength(1);
  });

  it('enforces the per-owner quota atomically, including racing creates across connections', async () => {
    for (let i = 0; i < SKILL_LIMITS.saved - 1; i += 1) {
      await store.create('owner-q', body(`quota ${i}`));
    }
    const { store: second } = await isolatedStore(dbPath);
    const results = await Promise.allSettled([
      store.create('owner-q', body('quota last a')),
      second.create('owner-q', body('quota last b')),
      store.create('owner-q', body('quota last c')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
      expect((r.reason as SkillError).code).toBe('SKILL_QUOTA_EXCEEDED');
      expect((r.reason as SkillError).status).toBe(409);
    }
    expect(await store.list('owner-q')).toHaveLength(SKILL_LIMITS.saved);
    // Quota is per owner.
    const other = await store.create('owner-x', body('quota other owner'));
    await store.remove('owner-x', other.id, 1);
  });

  it('rejects stale writes and deletes, and only one concurrent CAS update wins', async () => {
    const s = await store.create('owner-a', body('stale'));
    await store.update('owner-a', s.id, 1, { name: 'v2' });
    await expectSkillError(
      store.update('owner-a', s.id, 1, { name: 'lost' }),
      409,
      'REVISION_CONFLICT',
    );
    await expectSkillError(store.remove('owner-a', s.id, 1), 409, 'REVISION_CONFLICT');
    await expectSkillError(
      store.update('owner-a', s.id, 99, { name: 'x' }),
      409,
      'REVISION_CONFLICT',
    );

    const { store: second } = await isolatedStore(dbPath);
    const race = await Promise.allSettled([
      store.update('owner-a', s.id, 2, { name: 'A' }),
      second.update('owner-a', s.id, 2, { name: 'B' }),
      store.update('owner-a', s.id, 2, { name: 'C' }),
    ]);
    const winners = race.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      name: string;
      revision: number;
    }>[];
    expect(winners).toHaveLength(1);
    expect(winners[0].value.revision).toBe(3);
    const current = await store.get('owner-a', s.id);
    expect(current.name).toBe(winners[0].value.name);
    expect(current.revision).toBe(3);
    await store.remove('owner-a', s.id, 3);
  });

  it('scopes every operation to the owner', async () => {
    const s = await store.create('owner-a', body('owned'));
    await expectSkillError(store.get('owner-b', s.id), 404, 'NOT_FOUND');
    await expectSkillError(store.update('owner-b', s.id, 1, { name: 'x' }), 404, 'NOT_FOUND');
    await expectSkillError(store.remove('owner-b', s.id, 1), 404, 'NOT_FOUND');
    expect((await store.list('owner-b')).map((x) => x.id)).not.toContain(s.id);
    expect((await store.listEnabled('owner-b')).matches.map((x) => x.id)).not.toContain(s.id);
    expect(await store.get('owner-a', s.id)).toMatchObject({ revision: 1, name: 'Skill owned' });
    await expectSkillError(store.list(''), 401, 'UNAUTHENTICATED');
    await expectSkillError(store.create('missing-owner', body('ghost')), 401, 'UNAUTHENTICATED');
    await store.remove('owner-a', s.id, 1);
  });

  it('lists by name then id in code-point order, independent of UTF-16/locale order', async () => {
    const ids = ['id-\u{1F600}', 'id-\uFF5E'];
    let n = 0;
    const ordered = createSkillStore({
      sequelize: b.sequelize,
      model: b.skillModule!.Skill,
      logger: captureLogger,
      generateId: () => ids[n++],
    });
    await addOwner(b, 'owner-order');
    await ordered.create('owner-order', body('o1', { name: 'Same' }));
    await ordered.create('owner-order', body('o2', { name: 'Same' }));
    const names = ['b', 'B', '\u{1F600}', '\uFF5E', 'a'];
    for (const [i, name] of names.entries()) {
      await store.create('owner-order', body(`order ${i}`, { name }));
    }
    const list = await store.list('owner-order');
    expect(list.map((s) => s.name)).toEqual(['B', 'Same', 'Same', 'a', 'b', '\uFF5E', '\u{1F600}']);
    // Same name: id tie-break by code point (U+FF5E < U+1F600, unlike UTF-16).
    expect(list.filter((s) => s.name === 'Same').map((s) => s.id)).toEqual([
      'id-\uFF5E',
      'id-\u{1F600}',
    ]);
    const enabled = await store.listEnabled('owner-order');
    expect(enabled.matches.map((s) => s.id).filter((id) => id.startsWith('id-'))).toEqual([
      'id-\uFF5E',
      'id-\u{1F600}',
    ]);
  });

  it('listEnabled returns frozen snapshots of enabled valid rows and warns/skips invalid rows', async () => {
    await addOwner(b, 'owner-inv');
    const good = await store.create('owner-inv', body('good one'));
    const off = await store.create('owner-inv', body('disabled one', { enabled: false }));
    // Simulates rows written outside the API (manual edits, older/newer versions).
    const insert = (id: string, row: Record<string, unknown>) =>
      b.sequelize.query(
        `INSERT INTO skills (id, subscription_id, name, keyword, normalized_keyword, instructions, enabled, revision, createdAt, updatedAt)
         VALUES ($id, 'owner-inv', $name, $keyword, $nk, $instructions, $enabled, $revision, '2026-11-11 00:00:00.000 +00:00', '2026-11-11 00:00:00.000 +00:00')`,
        {
          bind: {
            id,
            name: 'Bad',
            keyword: 'bad',
            nk: id,
            instructions: SECRET,
            enabled: 1,
            revision: 1,
            ...row,
          },
        },
      );
    await insert('bad-long', { instructions: SECRET + 'x'.repeat(8_000) });
    await insert('bad-name', { name: '   ' });
    await insert('bad-reserved', { keyword: '@omniagent' });
    await insert('bad-revision', { revision: 0 });
    await insert('bad-control', { instructions: `${SECRET}\u0000` });
    await insert('bad-disabled', { name: '', enabled: 0 });

    logs.length = 0;
    const result = await store.listEnabled('owner-inv');
    expect(result.matches.map((m) => m.id)).toEqual([good.id]);
    expect(result.matches[0]).toEqual({
      id: good.id,
      name: good.name,
      keyword: good.keyword,
      revision: 1,
      instructions: good.instructions,
    });
    expect(Object.isFrozen(result.matches[0])).toBe(true);
    expect(Object.isFrozen(result.matches)).toBe(true);
    expect(result.matches.map((m) => m.id)).not.toContain(off.id);
    expect(result.warnings).toEqual(
      ['bad-control', 'bad-long', 'bad-name', 'bad-reserved', 'bad-revision'].map((skillId) => ({
        code: 'INVALID_SKILL',
        skillId,
        message: 'A saved skill is invalid and was skipped.',
      })),
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(SECRET);

    // The management list still shows type-valid rows so the owner can fix or delete them.
    expect((await store.list('owner-inv')).map((s) => s.id)).toEqual(
      expect.arrayContaining(['bad-long', 'bad-name', 'bad-reserved']),
    );
    // Rows whose types cannot be represented are skipped from list and fail get safely.
    expect((await store.list('owner-inv')).map((s) => s.id)).not.toContain('bad-revision');
    await expectSkillError(store.get('owner-inv', 'bad-revision'), 500, 'INTERNAL_ERROR');
    // An invalid row can be repaired via PATCH, then it becomes matchable.
    await store.update('owner-inv', 'bad-long', 1, { instructions: 'fixed' });
    expect((await store.listEnabled('owner-inv')).matches.map((m) => m.id)).toContain('bad-long');
  });

  it('fresh reads: edits through another connection are visible to the next resolution', async () => {
    await addOwner(b, 'owner-fresh');
    const s = await store.create('owner-fresh', body('fresh'));
    const { store: other } = await isolatedStore(dbPath);
    expect((await other.listEnabled('owner-fresh')).matches[0].instructions).toContain(SECRET);
    await other.update('owner-fresh', s.id, 1, { instructions: 'edited elsewhere' });
    expect((await store.listEnabled('owner-fresh')).matches[0]).toMatchObject({
      instructions: 'edited elsewhere',
      revision: 2,
    });
    await other.update('owner-fresh', s.id, 2, { enabled: false });
    expect((await store.listEnabled('owner-fresh')).matches).toEqual([]);
    await other.remove('owner-fresh', s.id, 3);
    await expectSkillError(store.get('owner-fresh', s.id), 404, 'NOT_FOUND');
  });

  it('composes a resolver that reads fresh, deduplicates warnings and propagates failures', async () => {
    const listEnabled = vi.fn(async () => ({
      matches: [
        Object.freeze({ id: 's1', name: 'n', keyword: 'k', revision: 1, instructions: 'i' }),
      ],
      warnings: [{ code: 'INVALID_SKILL' as const, skillId: 'x', message: 'm' }],
    }));
    const match = vi.fn((_text: string, snapshots: readonly unknown[]) => ({
      matches: snapshots as never,
      warnings: [
        { code: 'INVALID_SKILL' as const, skillId: 'x', message: 'm' },
        { code: 'INVALID_SKILL' as const, skillId: 'y', message: 'm' },
      ],
    }));
    const resolve = createSkillInputResolver({ listEnabled }, match);
    const r = await resolve('owner-a', 'text');
    expect(match).toHaveBeenCalledWith('text', expect.any(Array));
    expect(r.warnings.map((w) => w.skillId)).toEqual(['x', 'y']);
    await resolve('owner-a', 'text');
    expect(listEnabled).toHaveBeenCalledTimes(2);

    const failing = createSkillInputResolver(
      {
        listEnabled: async () => {
          throw new SkillError(
            503,
            'STORE_UNAVAILABLE',
            'Skills are temporarily unavailable. Please retry.',
          );
        },
      },
      match,
    );
    await expectSkillError(failing('owner-a', 'text'), 503, 'STORE_UNAVAILABLE');
  });
});

describe('skill store unavailable (fail closed, safe errors)', () => {
  it('returns 503 STORE_UNAVAILABLE when no database is configured', async () => {
    const { defineSkillModel } = await import('../models/skill');
    const dummy = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    openInstances.push(dummy);
    const store = createSkillStore({
      sequelize: undefined,
      model: defineSkillModel(dummy),
      logger: captureLogger,
    });
    await expectSkillError(store.listEnabled('owner-a'), 503, 'STORE_UNAVAILABLE');
    await expectSkillError(store.create('owner-a', body('x')), 503, 'STORE_UNAVAILABLE');
  });

  const unopenable = async (name: string, readTimeoutMs = 200) => {
    const sqlite3 = await import('sqlite3');
    const seq = new Sequelize({
      dialect: 'sqlite',
      storage: path.join(tmpRoot, 'missing-dir-readonly', name),
      logging: false,
      dialectOptions: { mode: sqlite3.default.OPEN_READONLY },
    });
    openInstances.push(seq);
    const { defineSkillModel } = await import('../models/skill');
    return createSkillStore({
      sequelize: seq,
      model: defineSkillModel(seq),
      logger: captureLogger,
      readTimeoutMs,
    });
  };
  const operations = (store: SkillCrudStore) => ({
    list: () => store.list('owner-a'),
    get: () => store.get('owner-a', 'x'),
    create: () => store.create('owner-a', body('x')),
    update: () => store.update('owner-a', 'x', 1, { name: 'x' }),
    remove: () => store.remove('owner-a', 'x', 1),
    listEnabled: () => store.listEnabled('owner-a'),
  });

  it.each(['list', 'get', 'create', 'update', 'remove', 'listEnabled'] as const)(
    'maps a database that cannot be opened to 503 (%s)',
    async (op) => {
      const store = await unopenable(`absent-${op}.sqlite`);
      logs.length = 0;
      const err = await expectSkillError(operations(store)[op](), 503, 'STORE_UNAVAILABLE');
      expect(err.message).toBe('Skills are temporarily unavailable. Please retry.');
      expect(JSON.stringify(logs)).not.toMatch(/SELECT|INSERT|absent-/);
    },
  );

  it('fails reads closed with 503 when the driver hangs after a failed open', async () => {
    const store = await unopenable('absent-hang.sqlite', 150);
    await expectSkillError(store.listEnabled('owner-a'), 503, 'STORE_UNAVAILABLE');
    // Sequelize's SQLite dialect caches the failed handle; later queries never settle.
    const started = Date.now();
    for (const op of [store.listEnabled, store.list] as const) {
      await expectSkillError(op('owner-a'), 503, 'STORE_UNAVAILABLE');
    }
    await expectSkillError(store.get('owner-a', 'x'), 503, 'STORE_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('maps a closed database instance to 503', async () => {
    const seq = new Sequelize({
      dialect: 'sqlite',
      storage: path.join(tmpRoot, 'closed.sqlite'),
      logging: false,
    });
    const { defineSkillModel } = await import('../models/skill');
    const model = defineSkillModel(seq);
    await model.sync();
    await seq.close();
    const store = createSkillStore({ sequelize: seq, model, logger: captureLogger });
    for (const op of Object.values(operations(store))) {
      await expectSkillError(op(), 503, 'STORE_UNAVAILABLE');
    }
  });

  it('maps a missing skills table (store not migrated) to 503 without leaking SQL', async () => {
    const seq = new Sequelize({
      dialect: 'sqlite',
      storage: path.join(tmpRoot, 'empty.sqlite'),
      logging: false,
    });
    openInstances.push(seq);
    const { defineSkillModel } = await import('../models/skill');
    const store = createSkillStore({
      sequelize: seq,
      model: defineSkillModel(seq),
      logger: captureLogger,
    });
    logs.length = 0;
    const err = await expectSkillError(store.listEnabled('owner-a'), 503, 'STORE_UNAVAILABLE');
    expect(err.fields).toBeUndefined();
    await expectSkillError(store.create('owner-a', body('secret kw')), 503, 'STORE_UNAVAILABLE');
    expect(JSON.stringify(logs)).not.toMatch(/SELECT|INSERT|secret kw/);
  });
});
