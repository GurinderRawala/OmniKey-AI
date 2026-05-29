import { Sequelize } from 'sequelize';
import { config } from './config';
import { Logger } from 'winston';

let sequelize: Sequelize;
if (config.isSelfHosted) {
  // Use SQLite for self-hosted users
  const dbPath = config.sqlitePath || 'omnikey-selfhosted.sqlite';
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: dbPath,
    logging: config.dbLogging ? console.log : false,
  });
} else if (config.blockSaas) {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
} else if (config.databaseUrl) {
  // Use Postgres for cloud/hosted
  sequelize = new Sequelize(config.databaseUrl, {
    dialect: 'postgres',
    logging: config.dbLogging ? console.log : false,
  });
}

export { sequelize };

// ---------------------------------------------------------------------------
// SQLite column migrations
//
// SQLite supports ALTER TABLE … ADD COLUMN safely — it never recreates the
// table, so existing rows are preserved and simply receive the column's
// DEFAULT value. Add every column that was introduced after the initial
// table creation here. The helper checks PRAGMA table_info first so running
// this on a fresh DB (where sync() already created every column) is a no-op.
// ---------------------------------------------------------------------------

interface ColumnMigration {
  table: string;
  column: string;
  definition: string; // SQL fragment after the column name, e.g. "INTEGER NOT NULL DEFAULT 0"
}

const COLUMN_MIGRATIONS: ColumnMigration[] = [
  // Added: context-window tracking (prompt token count of last API call)
  { table: 'agent_sessions', column: 'last_prompt_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Added: project grouping
  { table: 'agent_sessions', column: 'group_name',        definition: 'VARCHAR(255)' },
  { table: 'agent_sessions', column: 'group_description', definition: 'TEXT' },
];

async function runSQLiteMigrations(logger: Logger): Promise<void> {
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    const rows = (await sequelize.query(`PRAGMA table_info(${table})`))[0] as Array<{
      name: string;
    }>;
    const exists = rows.some((r) => r.name === column);
    if (!exists) {
      await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      logger.info(`SQLite migration: added column ${table}.${column}`);
    }
  }
}

export async function initDatabase(logger: Logger): Promise<void> {
  try {
    await sequelize.authenticate();
    // Use `alter: true` only for Postgres, not for SQLite.
    // On SQLite, sync() creates any missing tables from scratch (safe for new
    // installs) and then runSQLiteMigrations() adds any columns that were
    // introduced after the table was first created (safe for upgrades).
    if (sequelize.getDialect() === 'sqlite') {
      await sequelize.sync();
      await runSQLiteMigrations(logger);
      logger.info('Database connection established and models synchronized (SQLite).');
    } else {
      await sequelize.sync({ alter: true });
      logger.info('Database connection established and models synchronized (alter: true).');
    }
  } catch (err) {
    logger.error('Unable to connect to the database:', err);
    throw err;
  }
}
