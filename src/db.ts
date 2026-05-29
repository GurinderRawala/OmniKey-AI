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

  // mcp_servers was originally created with UNIQUE on both subscription_id and
  // name as column-level constraints (SQLite auto-indexes). These can't be
  // dropped with DROP INDEX — the only fix is to recreate the table with the
  // correct schema (composite unique on subscription_id+name only).
  await migrateMcpServersTableIfNeeded(logger);
}

async function migrateMcpServersTableIfNeeded(logger: Logger): Promise<void> {
  // Check if the old schema is still in place by inspecting the CREATE TABLE sql.
  const rows = (await sequelize.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_servers'`
  ))[0] as Array<{ sql: string }>;

  if (!rows.length) return; // table doesn't exist yet — sync() will create it correctly

  const createSql = rows[0].sql;
  // Old schema has UNIQUE on subscription_id at the column level.
  // New schema only has the composite index mcp_servers_subscription_id_name.
  const needsMigration = /`subscription_id`[^,]*UNIQUE/i.test(createSql);
  if (!needsMigration) return;

  logger.info('SQLite migration: recreating mcp_servers table to remove stale UNIQUE constraints');

  await sequelize.query('PRAGMA foreign_keys = OFF');
  try {
    await sequelize.query('BEGIN TRANSACTION');

    await sequelize.query(`
      CREATE TABLE \`mcp_servers_new\` (
        \`id\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`subscription_id\` VARCHAR(255) NOT NULL REFERENCES \`subscriptions\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
        \`name\` VARCHAR(100) NOT NULL,
        \`description\` VARCHAR(500),
        \`transport\` VARCHAR(16) NOT NULL DEFAULT 'stdio',
        \`command\` VARCHAR(500),
        \`args\` JSON NOT NULL DEFAULT '[]',
        \`env\` JSON NOT NULL DEFAULT '{}',
        \`url\` VARCHAR(1000),
        \`headers\` JSON NOT NULL DEFAULT '{}',
        \`is_enabled\` TINYINT(1) NOT NULL DEFAULT 1,
        \`last_connected_at\` DATETIME,
        \`last_error\` TEXT,
        \`createdAt\` DATETIME NOT NULL,
        \`updatedAt\` DATETIME NOT NULL
      )
    `);

    await sequelize.query(`
      INSERT INTO \`mcp_servers_new\`
        SELECT id, subscription_id, name, description, transport, command, args, env,
               url, headers, is_enabled, last_connected_at, last_error, createdAt, updatedAt
        FROM \`mcp_servers\`
    `);

    await sequelize.query('DROP TABLE `mcp_servers`');
    await sequelize.query('ALTER TABLE `mcp_servers_new` RENAME TO `mcp_servers`');

    await sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS \`mcp_servers_subscription_id_name\`
        ON \`mcp_servers\` (\`subscription_id\`, \`name\`)
    `);

    await sequelize.query('COMMIT');
    logger.info('SQLite migration: mcp_servers table recreated successfully');
  } catch (err) {
    await sequelize.query('ROLLBACK');
    throw err;
  } finally {
    await sequelize.query('PRAGMA foreign_keys = ON');
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
