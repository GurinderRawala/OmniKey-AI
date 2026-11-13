import fs from 'fs';
import os from 'os';
import path from 'path';
import { Sequelize, Transaction } from 'sequelize';
import { Database } from 'sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSQLiteReliability,
  enableSQLiteWAL,
  withTranscriptTransaction,
} from '../sqliteReliability';

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

it('shares asynchronous timeout initialization and never configures a cached connection synchronously', async () => {
  let complete!: (error?: Error) => void;
  const connection = {
    configure: vi.fn(() => {
      throw new Error('must not block the event loop');
    }),
    run: vi.fn((_sql: string, callback: (error?: Error) => void) => {
      complete = callback;
    }),
  };
  const manager = { getConnection: vi.fn(async () => connection) };
  configureSQLiteReliability({
    getDialect: () => 'sqlite',
    connectionManager: manager,
  } as unknown as Sequelize);
  let acquired = false;
  const pending = Promise.all([manager.getConnection(), manager.getConnection()]).then((result) => {
    acquired = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(connection.run).toHaveBeenCalledTimes(1);
  expect(acquired).toBe(false);
  complete();
  expect(await pending).toEqual([connection, connection]);
  await manager.getConnection();
  expect(connection.run).toHaveBeenCalledTimes(1);
  expect(connection.configure).not.toHaveBeenCalled();
});

it('retries timeout initialization after an asynchronous failure', async () => {
  const run = vi.fn((_sql: string, callback: (error: Error | null) => void) =>
    callback(new Error('transient')),
  );
  const connection = { run };
  const manager = { getConnection: vi.fn(async () => connection) };
  configureSQLiteReliability({
    getDialect: () => 'sqlite',
    connectionManager: manager,
  } as unknown as Sequelize);
  await expect(manager.getConnection()).rejects.toThrow('transient');
  run.mockImplementationOnce((_sql, callback) => callback(null));
  await expect(manager.getConnection()).resolves.toBe(connection);
  expect(run).toHaveBeenCalledTimes(2);
});

it('serializes concurrent transcript publications including their ownership reads', async () => {
  const { sequelize } = await fixture();
  await enableSQLiteWAL(sequelize);
  await sequelize.query("UPDATE checkpoint SET value='0'");
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withTranscriptTransaction(sequelize, async (transaction) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await sequelize.query('SELECT * FROM checkpoint', { transaction });
          await new Promise((resolve) => setTimeout(resolve, 2));
          await sequelize.query('UPDATE checkpoint SET value=CAST(value AS INTEGER)+1', {
            transaction,
          });
        } finally {
          active--;
        }
      }),
    ),
  );
  expect(peak).toBe(1);
  const [saved] = await sequelize.query('SELECT value FROM checkpoint');
  expect(saved).toEqual([{ value: '8' }]);
});

it('retries the entire rolled-back transaction on busy errors without retaining partial writes', async () => {
  const { sequelize } = await fixture();
  let attempts = 0;
  await withTranscriptTransaction(sequelize, async (transaction) => {
    attempts++;
    const [before] = await sequelize.query('SELECT value FROM checkpoint', { transaction });
    expect(before).toEqual([{ value: 'saved' }]);
    await sequelize.query("UPDATE checkpoint SET value='complete'", { transaction });
    if (attempts === 1)
      throw Object.assign(new Error('writer contention'), { original: { code: 'SQLITE_BUSY' } });
  });
  expect(attempts).toBe(2);
  const [saved] = await sequelize.query('SELECT value FROM checkpoint');
  expect(saved).toEqual([{ value: 'complete' }]);
});

it('bounds busy retries and lets subsequent publications proceed after failure', async () => {
  const { sequelize } = await fixture();
  let attempts = 0;
  await expect(
    withTranscriptTransaction(sequelize, async () => {
      attempts++;
      throw Object.assign(new Error('still busy'), { original: { code: 'SQLITE_BUSY' } });
    }),
  ).rejects.toThrow('still busy');
  expect(attempts).toBe(3);
  const invalid = vi.fn(async () => {
    throw new Error('invalid data');
  });
  await expect(withTranscriptTransaction(sequelize, invalid)).rejects.toThrow('invalid data');
  expect(invalid).toHaveBeenCalledTimes(1);
  await expect(withTranscriptTransaction(sequelize, async () => 'recovered')).resolves.toBe(
    'recovered',
  );
});

it('holds the WAL write reservation before reading ownership so another writer cannot invalidate the snapshot', async () => {
  const { sequelize, reader } = await fixture();
  await enableSQLiteWAL(sequelize);
  reader.configure('busyTimeout', 1000);
  let outsideWrite!: Promise<void>;
  let outsideFinished = false;
  await withTranscriptTransaction(sequelize, async (transaction) => {
    await sequelize.query('SELECT * FROM checkpoint', { transaction });
    outsideWrite = run(reader, "UPDATE checkpoint SET value='external'").then(() => {
      outsideFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outsideFinished).toBe(false);
    await sequelize.query("UPDATE checkpoint SET value='transcript'", { transaction });
  });
  await outsideWrite;
  expect(await rows(reader, 'SELECT value FROM checkpoint')).toEqual([{ value: 'external' }]);
});
