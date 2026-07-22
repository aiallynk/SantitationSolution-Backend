'use strict';

const { DataTypes } = require('sequelize');

const addColumnIfMissing = async (queryInterface, table, column, definition) => {
  const description = await queryInterface.describeTable(table);
  if (!description[column]) await queryInterface.addColumn(table, column, definition);
};
const removeColumnIfExists = async (queryInterface, table, column) => {
  const description = await queryInterface.describeTable(table);
  if (description[column]) await queryInterface.removeColumn(table, column);
};

module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'tenants', 'ai_scoring_mode', {
      type: DataTypes.STRING(16), allowNull: false, defaultValue: 'medium',
    });
    await queryInterface.sequelize.query(`
      UPDATE tenants SET ai_scoring_mode = 'medium'
      WHERE ai_scoring_mode IS NULL OR ai_scoring_mode NOT IN ('light', 'medium', 'high')
    `);
    await addColumnIfMissing(queryInterface, 'inspections', 'ai_scoring_mode_applied', { type: DataTypes.STRING(16), allowNull: true });
    await addColumnIfMissing(queryInterface, 'inspections', 'ai_scoring_policy_version', { type: DataTypes.STRING(80), allowNull: true });
    await addColumnIfMissing(queryInterface, 'ai_analysis_results', 'ai_scoring_mode_applied', { type: DataTypes.STRING(16), allowNull: true });
    await addColumnIfMissing(queryInterface, 'ai_analysis_results', 'ai_scoring_policy_version', { type: DataTypes.STRING(80), allowNull: true });
    await addColumnIfMissing(queryInterface, 'ai_analysis_results', 'ai_base_score', { type: DataTypes.DECIMAL(6, 2), allowNull: true });
    await addColumnIfMissing(queryInterface, 'ai_analysis_results', 'ai_final_score', { type: DataTypes.DECIMAL(6, 2), allowNull: true });
    await addColumnIfMissing(queryInterface, 'ai_analysis_results', 'ai_severity_summary', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addIndex('tenants', ['ai_scoring_mode'], { name: 'tenants_ai_scoring_mode_idx' }).catch(() => null);
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('tenants', 'tenants_ai_scoring_mode_idx').catch(() => null);
    await removeColumnIfExists(queryInterface, 'ai_analysis_results', 'ai_severity_summary');
    await removeColumnIfExists(queryInterface, 'ai_analysis_results', 'ai_final_score');
    await removeColumnIfExists(queryInterface, 'ai_analysis_results', 'ai_base_score');
    await removeColumnIfExists(queryInterface, 'ai_analysis_results', 'ai_scoring_policy_version');
    await removeColumnIfExists(queryInterface, 'ai_analysis_results', 'ai_scoring_mode_applied');
    await removeColumnIfExists(queryInterface, 'inspections', 'ai_scoring_policy_version');
    await removeColumnIfExists(queryInterface, 'inspections', 'ai_scoring_mode_applied');
    await removeColumnIfExists(queryInterface, 'tenants', 'ai_scoring_mode');
  },
};
