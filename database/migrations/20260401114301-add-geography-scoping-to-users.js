'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('platform_users');

    if (!table.geography_type) {
      await queryInterface.addColumn('platform_users', 'geography_type', {
        type: Sequelize.STRING(80),
        allowNull: true,
      });
    }

    if (!table.geography_id) {
      await queryInterface.addColumn('platform_users', 'geography_id', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('platform_users');
    
    if (table.geography_type) {
      await queryInterface.removeColumn('platform_users', 'geography_type');
    }
    // We might NOT want to remove geography_id if it was there before, 
    // but the task is to enable "geography scoping" which usually includes both.
    // However, if geography_id is a key part of the original schema, we should skip removing it.
  }
};
