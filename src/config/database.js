const { Sequelize } = require('sequelize');
require('./env');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false,
  }
);

sequelize
  .authenticate()
  .then(() => {
    console.log('Database connected successfully');
  })
  .catch((err) => {
    console.error('Unable to connect to database:', err.message);
  });

module.exports = sequelize;

