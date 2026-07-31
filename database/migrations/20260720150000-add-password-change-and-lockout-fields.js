'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn('platform_users', 'must_change_password', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('platform_users', 'failed_login_attempts', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('platform_users', 'locked_until', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await queryInterface.addIndex('platform_users', ['tenant_id', 'must_change_password'], {
      name: 'platform_users_tenant_must_change_password_idx',
    });
    await queryInterface.addIndex('platform_users', ['locked_until'], {
      name: 'platform_users_locked_until_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('platform_users', 'platform_users_locked_until_idx');
    await queryInterface.removeIndex('platform_users', 'platform_users_tenant_must_change_password_idx');
    await queryInterface.removeColumn('platform_users', 'locked_until');
    await queryInterface.removeColumn('platform_users', 'failed_login_attempts');
    await queryInterface.removeColumn('platform_users', 'must_change_password');
  },
};
