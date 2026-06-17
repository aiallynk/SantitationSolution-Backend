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

module.exports = {
  // Additive only: stores an optional snapshot of the BLE sensor reading captured
  // during an inspection. Inspection submit/AI scoring never depends on this column,
  // so QR -> Before -> After -> Submit is unaffected when it is NULL.
  async up(queryInterface) {
    if (!(await tableExists(queryInterface, 'inspections'))) return;
    if (!(await columnExists(queryInterface, 'inspections', 'sensor_snapshot'))) {
      await queryInterface.addColumn('inspections', 'sensor_snapshot', {
        type: DataTypes.JSONB,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, 'inspections', 'sensor_snapshot')) {
      await queryInterface.removeColumn('inspections', 'sensor_snapshot');
    }
  },
};
