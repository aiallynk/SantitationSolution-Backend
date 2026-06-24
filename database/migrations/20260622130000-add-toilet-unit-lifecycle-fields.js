'use strict';

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.includes(tableName);
};

const columnExists = async (queryInterface, tableName, columnName) => {
  if (!(await tableExists(queryInterface, tableName))) return false;
  const description = await queryInterface.describeTable(tableName);
  return Boolean(description[columnName]);
};

const addColumnIfMissing = async (queryInterface, Sequelize, tableName, columnName, definition) => {
  if (await columnExists(queryInterface, tableName, columnName)) return;
  await queryInterface.addColumn(tableName, columnName, definition(Sequelize));
};

const removeColumnIfPresent = async (queryInterface, tableName, columnName) => {
  if (!(await columnExists(queryInterface, tableName, columnName))) return;
  await queryInterface.removeColumn(tableName, columnName);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, Sequelize, 'toilet_units', 'deactivated_at', (DataTypes) => ({
      type: DataTypes.DATE,
      allowNull: true,
    }));
    await addColumnIfMissing(queryInterface, Sequelize, 'toilet_units', 'deleted_at', (DataTypes) => ({
      type: DataTypes.DATE,
      allowNull: true,
    }));
    await addColumnIfMissing(queryInterface, Sequelize, 'toilet_units', 'lifecycle_reason', (DataTypes) => ({
      type: DataTypes.TEXT,
      allowNull: true,
    }));
    await addColumnIfMissing(queryInterface, Sequelize, 'toilet_units', 'lifecycle_updated_by', (DataTypes) => ({
      type: DataTypes.UUID,
      allowNull: true,
    }));
    if (await tableExists(queryInterface, 'toilet_units')) {
      await queryInterface.addIndex('toilet_units', ['facility_id', 'deleted_at'], {
        name: 'toilet_units_facility_deleted_idx',
      }).catch((error) => {
        if (!String(error?.message || '').includes('already exists')) throw error;
      });
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'toilet_units')) {
      await queryInterface.removeIndex('toilet_units', 'toilet_units_facility_deleted_idx').catch(() => null);
    }
    await removeColumnIfPresent(queryInterface, 'toilet_units', 'lifecycle_updated_by');
    await removeColumnIfPresent(queryInterface, 'toilet_units', 'lifecycle_reason');
    await removeColumnIfPresent(queryInterface, 'toilet_units', 'deleted_at');
    await removeColumnIfPresent(queryInterface, 'toilet_units', 'deactivated_at');
  },
};
