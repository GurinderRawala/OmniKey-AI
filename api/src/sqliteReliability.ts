import { Transaction, type Sequelize } from 'sequelize';
import type { Database } from 'sqlite3';

type SQLiteConnection = Database & { uuid?: string };
type SQLiteManager = {
  connections: Record<string, SQLiteConnection>;
  getConnection: (...args: any[]) => Promise<SQLiteConnection>;
  destroyConnection: (connection: SQLiteConnection) => Promise<void>;
};

/** Sequelize 6's SQLite connections bypass its pool. Its inherited pool-based
 * destroyConnection therefore does nothing after a failed COMMIT, leaving the
 * transaction open and blocking the entire database. Close the actual handle.
 */
export function configureSQLiteReliability(sequelize: Sequelize): void {
  if (sequelize.getDialect() !== 'sqlite') return;
  const manager = sequelize.connectionManager as unknown as SQLiteManager;
  const getConnection = manager.getConnection.bind(manager);
  const initialization = new WeakMap<SQLiteConnection, Promise<void>>();
  manager.getConnection = async (...args) => {
    const connection = await getConnection(...args);
    let ready = initialization.get(connection);
    if (!ready) {
      // configure() takes SQLite's mutex synchronously for open connections.
      // Under contention that can block the HTTP event loop for seconds. Run
      // the pragma off-thread, once, sharing initialization across callers.
      ready = new Promise<void>((resolve, reject) => {
        connection.run('PRAGMA busy_timeout = 5000', (error) =>
          error ? reject(error) : resolve(),
        );
      }).catch((error) => {
        initialization.delete(connection);
        throw error;
      });
      initialization.set(connection, ready);
    }
    await ready;
    return connection;
  };
  manager.destroyConnection = async (connection) => {
    await new Promise<void>((resolve, reject) => {
      connection.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, cached] of Object.entries(manager.connections)) {
      if (cached === connection) delete manager.connections[key];
    }
  };
}

export async function enableSQLiteWAL(sequelize: Sequelize): Promise<void> {
  if (sequelize.getDialect() === 'sqlite') {
    // Readers (sidebar refresh, grouping and job polling) must not block a
    // transcript writer's COMMIT. This setting persists across connections.
    await sequelize.query('PRAGMA journal_mode = WAL');
  }
}

const transcriptWriters = new WeakMap<Sequelize, Promise<unknown>>();

/** Only pass replayable database work: a busy failure retries the whole
 * transaction after rollback/connection cleanup, never just a stale statement.
 */
export function withTranscriptTransaction<T>(
  sequelize: Sequelize,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  if (sequelize.getDialect() !== 'sqlite') return sequelize.transaction(work);
  const previous = transcriptWriters.get(sequelize) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // Acquire the write lock BEFORE the ownership read. A deferred WAL
          // read transaction cannot upgrade after another writer commits.
          const options = { type: Transaction.TYPES.IMMEDIATE, retry: { max: 0 } };
          return await sequelize.transaction(options, work);
        } catch (error) {
          const code = (error as { original?: { code?: string } })?.original?.code;
          if (attempt >= 2 || !code?.startsWith('SQLITE_BUSY')) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    });
  // Serializing publications prevents queued SQLite busy waits from consuming
  // the native thread pool while its current writer still needs that pool.
  transcriptWriters.set(sequelize, current);
  void current
    .finally(() => {
      if (transcriptWriters.get(sequelize) === current) transcriptWriters.delete(sequelize);
    })
    .catch(() => {});
  return current;
}
