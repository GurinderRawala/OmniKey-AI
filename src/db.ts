import { Sequelize } from 'sequelize';
import { config } from './config';
import { Logger } from 'winston';

export const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: config.dbLogging ? console.log : false,
});

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
