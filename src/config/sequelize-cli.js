const path = require('path');
const { runtimeConfig } = require(path.resolve('src/config/runtime'));

const common = {
  dialect: 'postgres',
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_data',
  logging: false,
};

const ssl = runtimeConfig.database.ssl
  ? { require: true, rejectUnauthorized: false }
  : false;

const buildConfig = () => ({
  ...common,
  url: runtimeConfig.database.url,
  dialectOptions: ssl ? { ssl } : {},
});

module.exports = {
  development: buildConfig(),
  test: buildConfig(),
  production: buildConfig(),
};