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
  manager.getConnection = async (...args) => {
    const connection = await getConnection(...args);
    connection.configure('busyTimeout', 5_000);
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
