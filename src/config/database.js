const { Sequelize } = require('sequelize');
require('./env');

const getDialectOptions = () => {
  const sslEnabled = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
  if (!sslEnabled) {
    return {};
  }

  return {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  };
};

const buildSequelize = () => {
  const options = {
    dialect: 'postgres',
    logging: false,
    dialectOptions: getDialectOptions(),
    pool: {
      max: Number(process.env.DB_POOL_MAX || 20),
      min: Number(process.env.DB_POOL_MIN || 2),
      acquire: Number(process.env.DB_POOL_ACQUIRE || 30000),
      idle: Number(process.env.DB_POOL_IDLE || 10000),
    },
  };

  if (process.env.DATABASE_URL) {
    return new Sequelize(process.env.DATABASE_URL, options);
  }

  return new Sequelize(
    process.env.DB_NAME || 'sanitation_solution',
    process.env.DB_USER || 'postgres',
    process.env.DB_PASS || 'postgres',
    {
      ...options,
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
    }
  );
};

const sequelize = buildSequelize();

module.exports = sequelize;
