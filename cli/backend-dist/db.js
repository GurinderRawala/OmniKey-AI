"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sequelize = void 0;
exports.initDatabase = initDatabase;
const sequelize_1 = require("sequelize");
const config_1 = require("./config");
let sequelize;
if (config_1.config.isSelfHosted) {
    // Use SQLite for self-hosted users
    const dbPath = config_1.config.sqlitePath || 'omnikey-selfhosted.sqlite';
    exports.sequelize = sequelize = new sequelize_1.Sequelize({
        dialect: 'sqlite',
        storage: dbPath,
        logging: config_1.config.dbLogging ? console.log : false,
    });
}
else if (config_1.config.databaseUrl) {
    // Use Postgres for cloud/hosted
    exports.sequelize = sequelize = new sequelize_1.Sequelize(config_1.config.databaseUrl, {
        dialect: 'postgres',
        logging: config_1.config.dbLogging ? console.log : false,
    });
}
async function initDatabase(logger) {
    try {
        await sequelize.authenticate();
        // Use `alter: true` so schema changes to models (like new
        // subscription fields) are reflected in the database automatically
        // without requiring manual migrations for this small service.
        await sequelize.sync({ alter: true });
        logger.info('Database connection established and models synchronized.');
    }
    catch (err) {
        logger.error('Unable to connect to the database:', err);
        throw err;
    }
}
