import fs from 'fs';
import os from 'os';
import path from 'path';
import { Sequelize, Transaction } from 'sequelize';
import { Database } from 'sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { configureSQLiteReliability, enableSQLiteWAL } from '../sqliteReliability';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const run = (db: Database, sql: string) =>
  new Promise<void>((resolve, reject) => {
    db.run(sql, (error) => (error ? reject(error) : resolve()));
  });
const rows = (db: Database, sql: string) =>
  new Promise<unknown[]>((resolve, reject) => {
    db.all(sql, (error, result) => (error ? reject(error) : resolve(result)));
  });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-db-test-'));
  cleanups.push(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const storage = path.join(dir, 'test.sqlite');
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
    retry: { max: 0 },
  });
  configureSQLiteReliability(sequelize);
  cleanups.push(() => sequelize.close());
  await sequelize.query('CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, value TEXT)');
  await sequelize.query("INSERT INTO checkpoint VALUES (1, 'saved')");
  const reader = new Database(storage);
  reader.configure('busyTimeout', 30);
  cleanups.push(
    () => new Promise<void>((resolve, reject) => reader.close((e) => (e ? reject(e) : resolve()))),
  );
  return { sequelize, reader };
}

describe('SQLite daemon reliability', () => {
  it('releases the real connection after a busy COMMIT, so all sessions can keep reading and writing', async () => {
    const { sequelize, reader } = await fixture();
    await run(reader, 'BEGIN');
    await rows(reader, 'SELECT * FROM checkpoint');
    let failed: Transaction | undefined;
    await expect(
      sequelize.transaction(async (transaction) => {
        failed = transaction;
        (transaction as unknown as { connection: Database }).connection.configure(
          'busyTimeout',
          30,
        );
        await sequelize.query("UPDATE checkpoint SET value='not committed'", { transaction });
      }),
    ).rejects.toMatchObject({ original: { code: 'SQLITE_BUSY' } });
    const connection = (failed as unknown as { connection: Database & { open: boolean } })
      .connection;
    expect(connection.open).toBe(false);
    await run(reader, 'ROLLBACK');
    expect(await rows(reader, 'SELECT value FROM checkpoint')).toEqual([{ value: 'saved' }]);
    await sequelize.query("UPDATE checkpoint SET value='recovered'");
    expect(await rows(reader, 'SELECT value FROM checkpoint')).toEqual([{ value: 'recovered' }]);
  });

  it('allows transcript commits while a sidebar/group reader holds a snapshot', async () => {
    const { sequelize, reader } = await fixture();
    await enableSQLiteWAL(sequelize);
    await run(reader, 'BEGIN');
    await rows(reader, 'SELECT * FROM checkpoint');
    await sequelize.transaction(async (transaction) => {
      await sequelize.query("UPDATE checkpoint SET value='new checkpoint'", { transaction });
    });
    expect(await rows(reader, 'SELECT value FROM checkpoint')).toEqual([{ value: 'saved' }]);
    await run(reader, 'ROLLBACK');
    expect(await rows(reader, 'SELECT value FROM checkpoint')).toEqual([
      { value: 'new checkpoint' },
    ]);
  });
});
