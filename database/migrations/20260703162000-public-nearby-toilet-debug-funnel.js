'use strict';

const { DataTypes } = require('sequelize');

const normalizeTableName = (value) =>
  typeof value === 'string'
    ? value
    : value?.tableName || value?.table_name || String(value || '');

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
  if (!(await tableExists(queryInterface, tableName))) return;
  if (!(await columnExists(queryInterface, tableName, columnName))) {
    await queryInterface.addColumn(tableName, columnName, definition);
  }
};

const removeColumnIfPresent = async (queryInterface, tableName, columnName) => {
  if (await columnExists(queryInterface, tableName, columnName)) {
    await queryInterface.removeColumn(tableName, columnName);
  }
};

module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'tenants', 'external_api_sharing_enabled', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await addColumnIfMissing(queryInterface, 'toilet_units', 'location', {
      type: DataTypes.JSONB,
      allowNull: true,
    });

    const nullableInteger = { type: DataTypes.INTEGER, allowNull: true };
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'cleanliness_min', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'include_closed', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'eligible_tenant_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'candidate_toilet_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'returned_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_missing_coordinates_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_invalid_coordinates_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_tenant_sharing_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_api_scope_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_public_visibility_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_status_count', nullableInteger);
    await addColumnIfMissing(queryInterface, 'api_usage_logs', 'dropped_cleanliness_count', nullableInteger);
  },

  async down(queryInterface) {
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_cleanliness_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_status_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_public_visibility_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_api_scope_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_tenant_sharing_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_invalid_coordinates_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'dropped_missing_coordinates_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'returned_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'candidate_toilet_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'eligible_tenant_count');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'include_closed');
    await removeColumnIfPresent(queryInterface, 'api_usage_logs', 'cleanliness_min');
    await removeColumnIfPresent(queryInterface, 'toilet_units', 'location');
    await removeColumnIfPresent(queryInterface, 'tenants', 'external_api_sharing_enabled');
  },
};
