const { Sequelize } = require('sequelize');
const { runtimeConfig } = require('./runtime');

const getDialectOptions = () => {
  const sslEnabled = runtimeConfig.database.ssl;
  const statementTimeout = Number(runtimeConfig.database.statementTimeoutMs || 15000);
  const queryTimeout = Number(runtimeConfig.database.queryTimeoutMs || 15000);
  const idleTxnTimeout = Number(runtimeConfig.database.idleInTxnTimeoutMs || 15000);
  const connectionTimeout = Number(runtimeConfig.database.connectionTimeoutMs || 10000);

  const options = {
    ...(Number.isFinite(connectionTimeout) && connectionTimeout > 0
      ? { connectionTimeoutMillis: connectionTimeout }
      : {}),
    ...(Number.isFinite(statementTimeout) && statementTimeout > 0
      ? { statement_timeout: statementTimeout }
      : {}),
    ...(Number.isFinite(queryTimeout) && queryTimeout > 0
      ? { query_timeout: queryTimeout }
      : {}),
    ...(Number.isFinite(idleTxnTimeout) && idleTxnTimeout > 0
      ? { idle_in_transaction_session_timeout: idleTxnTimeout }
      : {}),
  };

  if (sslEnabled) {
    options.ssl = {
      require: true,
      rejectUnauthorized: false,
    };
  }
  return options;
};

const buildSequelize = () => {
  const options = {
    dialect: 'postgres',
    logging: runtimeConfig.database.loggingEnabled ? console.log : false,
    dialectOptions: getDialectOptions(),
    pool: {
      max: Number(runtimeConfig.database.poolMax || 20),
      min: Number(runtimeConfig.database.poolMin || 2),
      acquire: Number(runtimeConfig.database.poolAcquire || 30000),
      idle: Number(runtimeConfig.database.poolIdle || 10000),
      evict: Number(runtimeConfig.database.poolEvict || 1000),
      maxUses: Number(runtimeConfig.database.poolMaxUses || 5000),
    },
    retry: {
      max: Number(runtimeConfig.database.retryMax || 2),
    },
    benchmark: false,
  };

  return new Sequelize(runtimeConfig.database.url, options);
};

const sequelize = buildSequelize();

module.exports = sequelize;
