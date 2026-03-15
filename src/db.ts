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
} else if (config.databaseUrl) {
  // Use Postgres for cloud/hosted
  sequelize = new Sequelize(config.databaseUrl, {
    dialect: 'postgres',
    logging: config.dbLogging ? console.log : false,
  });
}

export { sequelize };

export async function initDatabase(logger: Logger): Promise<void> {
  try {
    await sequelize.authenticate();
    // Use `alter: true` so schema changes to models (like new
    // subscription fields) are reflected in the database automatically
    // without requiring manual migrations for this small service.
    await sequelize.sync({ alter: true });
    logger.info('Database connection established and models synchronized.');
  } catch (err) {
    logger.error('Unable to connect to the database:', err);
    throw err;
  }
}
