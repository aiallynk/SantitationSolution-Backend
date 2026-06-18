'use strict';

const { DataTypes, Sequelize } = require('sequelize');

const normalizeTableName = (value) =>
  typeof value === 'string'
    ? value
    : value?.tableName || value?.table_name || String(value || '');

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
};

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((idx) => idx.name === indexName)) {
    await queryInterface.addIndex(tableName, fields, { ...options, name: indexName });
  }
};

module.exports = {
  async up(queryInterface) {
    if (await tableExists(queryInterface, 'ai_usage_logs')) {
      return;
    }

    await queryInterface.createTable('ai_usage_logs', {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenant_id: { type: DataTypes.UUID, allowNull: true },
      user_id: { type: DataTypes.UUID, allowNull: true },
      worker_id: { type: DataTypes.UUID, allowNull: true },
      inspection_id: { type: DataTypes.UUID, allowNull: true },
      toilet_id: { type: DataTypes.UUID, allowNull: true },
      user_role: { type: DataTypes.STRING(80), allowNull: true },
      feature_key: { type: DataTypes.STRING(120), allowNull: false },
      feature_name: { type: DataTypes.STRING(200), allowNull: false },
      ai_provider: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'openai' },
      model_name: { type: DataTypes.STRING(120), allowNull: false },
      input_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      output_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      total_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      image_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      video_frame_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cost_usd: { type: DataTypes.DECIMAL(12, 8), allowNull: false, defaultValue: 0 },
      cost_inr: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0 },
      usd_to_inr_rate: { type: DataTypes.DECIMAL(8, 4), allowNull: false, defaultValue: 84.0 },
      is_estimated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: {
        type: DataTypes.ENUM('success', 'failed', 'partial'),
        allowNull: false,
        defaultValue: 'success',
      },
      latency_ms: { type: DataTypes.INTEGER, allowNull: true },
      error_message: { type: DataTypes.TEXT, allowNull: true },
      provider_request_id: { type: DataTypes.STRING(200), allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_tenant_id', ['tenant_id']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_created_at', ['created_at']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_tenant_created', ['tenant_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_user_created', ['user_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_worker_created', ['worker_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_feature_created', ['feature_key', 'created_at']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_model_created', ['model_name', 'created_at']);
    await addIndexIfMissing(queryInterface, 'ai_usage_logs', 'ai_usage_logs_status_created', ['status', 'created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ai_usage_logs');
  },
};
