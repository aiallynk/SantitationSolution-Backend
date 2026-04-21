const { runtimeConfig, validateRuntimeConfig } = require('./runtime');

module.exports = {
  ...runtimeConfig,
  NODE_ENV: runtimeConfig.env,
  PORT: runtimeConfig.app.port,
  IS_PRODUCTION: runtimeConfig.isProduction,
  validateRuntimeConfig,
};
