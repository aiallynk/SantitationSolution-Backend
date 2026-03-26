const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const Inspection = sequelize.define('Inspection', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  worker_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  toilet_code: {
    type: DataTypes.STRING(80),
    allowNull: true,
  },
  toilet_name: {
    type: DataTypes.STRING(120),
    allowNull: true,
  },
  city: {
    type: DataTypes.STRING(80),
    allowNull: true,
  },
  ward: {
    type: DataTypes.STRING(80),
    allowNull: true,
  },
  zone: {
    type: DataTypes.STRING(80),
    allowNull: true,
  },
  sector: {
    type: DataTypes.STRING(80),
    allowNull: true,
  },
  latitude: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true,
  },
  longitude: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true,
  },
  before_image_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  after_image_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  image_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  score_before: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  score_after: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  improvement_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  overall_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  severity: {
    type: DataTypes.ENUM('critical', 'poor', 'moderate', 'good', 'excellent'),
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed'),
    allowNull: false,
    defaultValue: 'pending',
  },
  findings_json: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  score_breakdown_json: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  remarks: {
    type: DataTypes.STRING(500),
    allowNull: true,
  },
  processed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'inspections',
  timestamps: false,
});

module.exports = Inspection;
