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
  async up(queryInterface) {
    if (!(await columnExists(queryInterface, 'api_projects', 'usage_by'))) {
      await queryInterface.addColumn('api_projects', 'usage_by', {
        type: DataTypes.STRING(220),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, 'api_projects', 'usage_by')) {
      await queryInterface.removeColumn('api_projects', 'usage_by');
    }
  },
};
