import type { Sequelize } from 'sequelize';
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
