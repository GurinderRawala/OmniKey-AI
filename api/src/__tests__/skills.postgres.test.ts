import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Sequelize } from 'sequelize';
import { createSkillStore, type SkillCrudStore } from '../skills/skillStore';
// Opt-in only: never use DATABASE_URL or any live database. CI supplies an
// explicitly disposable service, and local verification uses a private socket.
vi.mock('../db', async () => {
  const { Sequelize: S } = await import('sequelize');
  return { sequelize: new S({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});
import { defineSkillModel } from '../models/skill';
const socket = process.env.SKILLS_TEST_PG_SOCKET;
const url = process.env.SKILLS_TEST_PG_URL;
if (socket && url) throw new Error('Choose exactly one disposable Skills PostgreSQL test target.');
if (process.env.CI && !socket && !url)
  throw new Error('CI requires an explicit disposable Skills PostgreSQL target.');
describe.skipIf(!socket && !url)('Skills disposable PostgreSQL', () => {
  let db: Sequelize;
  let store: SkillCrudStore;
  let schema: string | undefined;
  beforeAll(async () => {
    schema = `skills_test_${process.pid}_${Date.now()}`;
    const hooks = {
      afterConnect: async (connection: unknown) => {
        await (connection as { query(sql: string): Promise<unknown> }).query(
          `SET search_path TO "${schema}"`,
        );
      },
    };
    db = socket
      ? new Sequelize('postgres', process.env.USER ?? 'postgres', '', {
          dialect: 'postgres',
          host: socket,
          port: 55439,
          logging: false,
          hooks,
        })
      : new Sequelize(url!, { logging: false, hooks });
    // A unique schema keeps the test isolated even in a disposable shared CI DB.
    await db.createSchema(schema, {});
    const [schemas] = await db.query('SELECT current_schema() AS schema');
    expect((schemas[0] as { schema: string }).schema).toBe(schema);
    await db.query('CREATE TABLE subscriptions (id VARCHAR(255) PRIMARY KEY)');
    await db.query("INSERT INTO subscriptions VALUES ('owner-a'), ('owner-b')");
    const model = defineSkillModel(db);
    await model.sync();
    await model.sync({ alter: true });
    store = createSkillStore({ sequelize: db, model, logger: { warn() {}, error() {} } });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      if (schema) await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await db.close();
    }
  });
  it('supports hosted CRUD, owner isolation, strong revisions and canonical uniqueness', async () => {
    const body = { name: 'Review', keyword: 'Code Review', instructions: 'Check edge cases.' };
    const skill = await store.create('owner-a', body);
    expect(skill.createdAt).toBe(skill.updatedAt);
    expect(await store.list('owner-b')).toEqual([]);
    await expect(store.get('owner-b', skill.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      store.create('owner-a', { ...body, keyword: 'ＣＯＤＥ   review' }),
    ).rejects.toMatchObject({ code: 'KEYWORD_CONFLICT' });
    const updated = await store.update('owner-a', skill.id, 1, { enabled: false });
    expect(updated.revision).toBe(2);
    await expect(store.remove('owner-a', skill.id, 1)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect((await store.listEnabled('owner-a')).matches).toEqual([]);
    await store.remove('owner-a', skill.id, 2);
  });
  it('serializes competing quota creates and duplicate keywords across pooled connections', async () => {
    const create = (keyword: string) =>
      store.create('owner-b', { name: keyword, keyword, instructions: 'x' });
    const duplicate = await Promise.allSettled([
      create('duplicate'),
      create('duplicate'),
      create('duplicate'),
    ]);
    expect(duplicate.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const item of duplicate)
      if (item.status === 'rejected') expect(item.reason.code).toBe('KEYWORD_CONFLICT');
    for (let i = 0; i < 98; i++) await create(`key${i}`);
    const quota = await Promise.allSettled([create('last1'), create('last2'), create('last3')]);
    expect(quota.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const item of quota)
      if (item.status === 'rejected') expect(item.reason.code).toBe('SKILL_QUOTA_EXCEEDED');
    expect(await store.list('owner-b')).toHaveLength(100);
  }, 30_000);
});
