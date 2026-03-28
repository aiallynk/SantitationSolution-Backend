const dotenv = require('dotenv');

dotenv.config({
  override: true,
  quiet: true,
});

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5000),
};

