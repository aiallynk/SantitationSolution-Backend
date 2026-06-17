'use strict';

const { DataTypes, Op } = require('sequelize');

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

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((idx) => idx.name === indexName)) {
    await queryInterface.addIndex(tableName, fields, { ...options, name: indexName });
  }
};

const removeIndexIfPresent = async (queryInterface, tableName, indexName) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some((idx) => idx.name === indexName)) {
    await queryInterface.removeIndex(tableName, indexName);
  }
};

module.exports = {
  // Additive only: enables idempotent BLE reading ingestion and fast per-toilet lookups.
  // Generic sensor fields (field_1..field_3) are stored in the existing raw_payload JSONB,
  // so no new value columns are introduced here.
  async up(queryInterface) {
    if (await tableExists(queryInterface, 'sensor_readings')) {
      if (!(await columnExists(queryInterface, 'sensor_readings', 'client_reading_id'))) {
        await queryInterface.addColumn('sensor_readings', 'client_reading_id', {
          type: DataTypes.STRING(120),
          allowNull: true,
        });
      }
      // Idempotency guard: a device may never store the same client_reading_id twice.
      // Partial unique index keeps legacy rows (NULL client_reading_id) unconstrained.
      await addIndexIfMissing(
        queryInterface,
        'sensor_readings',
        'sensor_readings_device_client_unique',
        ['device_id', 'client_reading_id'],
        { unique: true, where: { client_reading_id: { [Op.ne]: null } } }
      );
    }

    // Per-toilet latest/history/summary lookups resolve devices by toilet first.
    await addIndexIfMissing(
      queryInterface,
      'sensor_devices',
      'sensor_devices_toilet_unit_id',
      ['toilet_unit_id']
    );
  },

  async down(queryInterface) {
    await removeIndexIfPresent(queryInterface, 'sensor_devices', 'sensor_devices_toilet_unit_id');
    await removeIndexIfPresent(
      queryInterface,
      'sensor_readings',
      'sensor_readings_device_client_unique'
    );
    if (await columnExists(queryInterface, 'sensor_readings', 'client_reading_id')) {
      await queryInterface.removeColumn('sensor_readings', 'client_reading_id');
    }
  },
};
