const path = require('path');
require(path.resolve('src/config/env'));

const common = {
  dialect: 'postgres',
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_data',
  logging: false,
};

const buildConfig = () => {
  if (process.env.DATABASE_URL) {
    const ssl =
      String(process.env.DB_SSL || 'false').toLowerCase() === 'true'
        ? { require: true, rejectUnauthorized: false }
        : false;

    return {
      ...common,
      url: process.env.DATABASE_URL,
      dialectOptions: ssl ? { ssl } : {},
    };
  }

  return {
    ...common,
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'sanitation_solution',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
  };
};

module.exports = {
  development: buildConfig(),
  test: buildConfig(),
  production: buildConfig(),
};
