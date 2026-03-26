const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const Alert = sequelize.define('Alert', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  inspection_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  message: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  severity: {
    type: DataTypes.ENUM('critical', 'poor', 'moderate'),
    allowNull: false,
    defaultValue: 'poor',
  },
  status: {
    type: DataTypes.ENUM('open', 'acknowledged', 'resolved'),
    allowNull: false,
    defaultValue: 'open',
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'alerts',
  timestamps: false,
});

module.exports = Alert;
