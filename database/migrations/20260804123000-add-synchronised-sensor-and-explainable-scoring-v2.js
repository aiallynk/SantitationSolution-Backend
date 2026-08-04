'use strict';

const { DataTypes } = require('sequelize');

const normalizeTableName = (value) =>
  typeof value === 'string' ? value : value?.tableName || value?.table_name || String(value || '');

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
};

const columnExists = async (queryInterface, tableName, columnName) => {
  if (!(await tableExists(queryInterface, tableName))) return false;
  const description = await queryInterface.describeTable(tableName);
  return Object.prototype.hasOwnProperty.call(description, columnName);
};

const addColumnIfMissing = async (queryInterface, tableName, columnName, definition) => {
  if (await tableExists(queryInterface, tableName) && !(await columnExists(queryInterface, tableName, columnName))) {
    await queryInterface.addColumn(tableName, columnName, definition);
  }
};

const removeColumnIfPresent = async (queryInterface, tableName, columnName) => {
  if (await columnExists(queryInterface, tableName, columnName)) {
    await queryInterface.removeColumn(tableName, columnName);
  }
};

const addIndexIfMissing = async (queryInterface, tableName, name, fields) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((index) => index.name === name)) {
    await queryInterface.addIndex(tableName, fields, { name });
  }
};

const removeIndexIfPresent = async (queryInterface, tableName, name) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some((index) => index.name === name)) {
    await queryInterface.removeIndex(tableName, name);
  }
};

const mediaColumns = {
  evidence_id: { type: DataTypes.STRING(120), allowNull: true },
  camera_opened_at: { type: DataTypes.DATE, allowNull: true },
  shutter_requested_at: { type: DataTypes.DATE, allowNull: true },
  camera_exposure_at: { type: DataTypes.DATE, allowNull: true },
  image_returned_at: { type: DataTypes.DATE, allowNull: true },
  image_persisted_at: { type: DataTypes.DATE, allowNull: true },
  camera_timestamp_source: { type: DataTypes.STRING(60), allowNull: true },
  sensor_measured_at: { type: DataTypes.DATE, allowNull: true },
  sensor_received_at: { type: DataTypes.DATE, allowNull: true },
  sensor_timestamp_source: { type: DataTypes.STRING(60), allowNull: true },
  sensor_sync_delta_ms: { type: DataTypes.INTEGER, allowNull: true },
  sensor_sync_quality: { type: DataTypes.STRING(60), allowNull: true },
  sensor_stability: { type: DataTypes.STRING(60), allowNull: true },
  sensor_confidence: { type: DataTypes.STRING(30), allowNull: true },
  sensor_sample_count: { type: DataTypes.INTEGER, allowNull: true },
  sensor_window_median_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  sensor_window_min_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  sensor_window_max_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  sensor_window_spread: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  sensor_sequence: { type: DataTypes.BIGINT, allowNull: true },
  sensor_calibration_version: { type: DataTypes.STRING(100), allowNull: true },
  capture_protocol_version: { type: DataTypes.STRING(80), allowNull: true },
  sensor_evidence: { type: DataTypes.JSONB, allowNull: true },
};

const inspectionColumns = {
  scoring_mode: { type: DataTypes.STRING(16), allowNull: true },
  scoring_config_version: { type: DataTypes.STRING(80), allowNull: true },
  scoring_formula_version: { type: DataTypes.STRING(80), allowNull: true },
  ai_model_version: { type: DataTypes.STRING(120), allowNull: true },
  sensor_calibration_version: { type: DataTypes.STRING(100), allowNull: true },
  capture_protocol_version: { type: DataTypes.STRING(80), allowNull: true },
  scoring_explanation_json: { type: DataTypes.JSONB, allowNull: true },
  component_scores_json: { type: DataTypes.JSONB, allowNull: true },
  score_reasons_json: { type: DataTypes.JSONB, allowNull: true },
};

const analysisColumns = {
  scoring_mode: { type: DataTypes.STRING(16), allowNull: true },
  scoring_config_version: { type: DataTypes.STRING(80), allowNull: true },
  scoring_formula_version: { type: DataTypes.STRING(80), allowNull: true },
  ai_model_version_v2: { type: DataTypes.STRING(120), allowNull: true },
  sensor_calibration_version: { type: DataTypes.STRING(100), allowNull: true },
  capture_protocol_version: { type: DataTypes.STRING(80), allowNull: true },
  scoring_explanation_json: { type: DataTypes.JSONB, allowNull: true },
  component_scores_json: { type: DataTypes.JSONB, allowNull: true },
  score_reasons_json: { type: DataTypes.JSONB, allowNull: true },
};

module.exports = {
  // Additive only. Existing media, inspections and scores remain exactly as recorded.
  async up(queryInterface) {
    for (const [column, definition] of Object.entries(mediaColumns)) {
      await addColumnIfMissing(queryInterface, 'inspection_media', column, definition);
    }
    for (const [column, definition] of Object.entries(inspectionColumns)) {
      await addColumnIfMissing(queryInterface, 'inspections', column, definition);
    }
    for (const [column, definition] of Object.entries(analysisColumns)) {
      await addColumnIfMissing(queryInterface, 'ai_analysis_results', column, definition);
    }
    await addIndexIfMissing(queryInterface, 'inspection_media', 'inspection_media_evidence_id_idx', ['evidence_id']);
    await addIndexIfMissing(queryInterface, 'inspection_media', 'inspection_media_sensor_sync_idx', ['sensor_sync_quality', 'captured_at']);
    await addIndexIfMissing(queryInterface, 'inspections', 'inspections_scoring_formula_idx', ['scoring_formula_version', 'scoring_mode']);
  },

  async down(queryInterface) {
    // Rollout rollback is controlled by tenant flags. Do not erase capture
    // evidence or score snapshots from historical rows merely because a
    // migration is rolled back. The nullable columns stay in place.
    await removeIndexIfPresent(queryInterface, 'inspections', 'inspections_scoring_formula_idx');
    await removeIndexIfPresent(queryInterface, 'inspection_media', 'inspection_media_sensor_sync_idx');
    await removeIndexIfPresent(queryInterface, 'inspection_media', 'inspection_media_evidence_id_idx');
  },
};
