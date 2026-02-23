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
    await sequelize.sync();
    logger.info('Database connection established and models synchronized.');
  } catch (err) {
    logger.error('Unable to connect to the database:', err);
    throw err;
  }
}
