'use strict';

const { DataTypes } = require('sequelize');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('inspection_submissions', 'submitted_to_role', {
      type: DataTypes.STRING(80),
      allowNull: true,
    });

    await queryInterface.addColumn('inspection_submissions', 'submitted_to_scope', {
      type: DataTypes.STRING(80),
      allowNull: true,
    });

    await queryInterface.addColumn('inspection_submissions', 'submitted_by_user', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    await queryInterface.addIndex('inspection_submissions', ['submitted_to_role'], {
      name: 'inspection_submissions_submitted_to_role_idx',
    });
    await queryInterface.addIndex('inspection_submissions', ['submitted_to_scope'], {
      name: 'inspection_submissions_submitted_to_scope_idx',
    });
    await queryInterface.addIndex('inspection_submissions', ['submitted_by_user'], {
      name: 'inspection_submissions_submitted_by_user_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('inspection_submissions', 'inspection_submissions_submitted_by_user_idx');
    await queryInterface.removeIndex('inspection_submissions', 'inspection_submissions_submitted_to_scope_idx');
    await queryInterface.removeIndex('inspection_submissions', 'inspection_submissions_submitted_to_role_idx');

    await queryInterface.removeColumn('inspection_submissions', 'submitted_by_user');
    await queryInterface.removeColumn('inspection_submissions', 'submitted_to_scope');
    await queryInterface.removeColumn('inspection_submissions', 'submitted_to_role');
  },
};
