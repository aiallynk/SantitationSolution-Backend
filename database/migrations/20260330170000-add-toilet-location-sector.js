'use strict';

const { DataTypes } = require('sequelize');

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const description = await queryInterface.describeTable(table);
  if (!description[column]) {
    await queryInterface.addColumn(table, column, spec);
  }
};

const removeColumnIfExists = async (queryInterface, table, column) => {
  const description = await queryInterface.describeTable(table);
  if (description[column]) {
    await queryInterface.removeColumn(table, column);
  }
};

const addIndexSafe = async (queryInterface, table, fields, name) => {
  try {
    await queryInterface.addIndex(table, fields, { name });
  } catch (_) {
    // no-op when already exists
  }
};

const removeIndexSafe = async (queryInterface, table, name) => {
  try {
    await queryInterface.removeIndex(table, name);
  } catch (_) {
    // no-op when not exists
  }
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'toilet_units', 'sector_code', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'location_label', {
      type: DataTypes.STRING(300),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'latitude', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'longitude', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });

    await addIndexSafe(queryInterface, 'toilet_units', ['sector_code'], 'toilet_units_sector_code_idx');
    await addIndexSafe(queryInterface, 'toilet_units', ['latitude', 'longitude'], 'toilet_units_lat_lng_idx');
  },

  async down(queryInterface) {
    await removeIndexSafe(queryInterface, 'toilet_units', 'toilet_units_sector_code_idx');
    await removeIndexSafe(queryInterface, 'toilet_units', 'toilet_units_lat_lng_idx');

    await removeColumnIfExists(queryInterface, 'toilet_units', 'longitude');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'latitude');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'location_label');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'sector_code');
  },
};

