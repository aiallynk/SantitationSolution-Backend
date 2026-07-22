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
  // The wand firmware now sends a single PPM (TGS gas concentration sensor)
  // reading instead of the legacy odor/ammonia/h2s/methane channels, which
  // were never populated by any real hardware (values only ever lived in
  // raw_payload JSONB). Adds a dedicated `ppm` column and drops the dead ones.
  async up(queryInterface) {
    if (!(await tableExists(queryInterface, 'sensor_readings'))) return;

    if (!(await columnExists(queryInterface, 'sensor_readings', 'ppm'))) {
      await queryInterface.addColumn('sensor_readings', 'ppm', {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      });
    }

    for (const column of ['odor_ppm', 'ammonia_ppm', 'h2s_ppm', 'methane_ppm']) {
      if (await columnExists(queryInterface, 'sensor_readings', column)) {
        await queryInterface.removeColumn('sensor_readings', column);
      }
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'sensor_readings'))) return;

    for (const column of ['odor_ppm', 'ammonia_ppm', 'h2s_ppm', 'methane_ppm']) {
      if (!(await columnExists(queryInterface, 'sensor_readings', column))) {
        await queryInterface.addColumn('sensor_readings', column, {
          type: DataTypes.DECIMAL(10, 2),
          allowNull: true,
        });
      }
    }

    if (await columnExists(queryInterface, 'sensor_readings', 'ppm')) {
      await queryInterface.removeColumn('sensor_readings', 'ppm');
    }
  },
};
