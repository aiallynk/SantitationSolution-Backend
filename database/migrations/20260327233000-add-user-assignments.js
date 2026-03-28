'use strict';

const { DataTypes, Sequelize } = require('sequelize');

const uuidPk = {
  type: DataTypes.UUID,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
  allowNull: false,
};

const timestamps = {
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('platform_users', 'employee_code', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });

    await queryInterface.addColumn('platform_users', 'metadata', {
      type: DataTypes.JSONB,
      allowNull: true,
    });

    await queryInterface.addIndex('platform_users', ['tenant_id', 'employee_code'], {
      name: 'platform_users_tenant_employee_code_uk',
      unique: true,
      where: {
        employee_code: {
          [Sequelize.Op.ne]: null,
        },
      },
    });

    await queryInterface.createTable('worker_assignments', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'CASCADE',
      },
      geography_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onDelete: 'SET NULL',
      },
      facility_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'SET NULL',
      },
      toilet_unit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'toilet_units', key: 'id' },
        onDelete: 'SET NULL',
      },
      assignment_level: {
        type: DataTypes.ENUM('tenant', 'geography', 'facility', 'toilet_unit'),
        allowNull: false,
        defaultValue: 'facility',
      },
      assignment_role: {
        type: DataTypes.STRING(80),
        allowNull: false,
        defaultValue: 'worker',
      },
      status: {
        type: DataTypes.ENUM('active', 'inactive'),
        allowNull: false,
        defaultValue: 'active',
      },
      created_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      updated_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      ...timestamps,
    });

    await queryInterface.addConstraint('worker_assignments', {
      type: 'unique',
      fields: ['tenant_id', 'user_id', 'geography_id', 'facility_id', 'toilet_unit_id', 'assignment_role'],
      name: 'worker_assignments_scope_uk',
    });

    await queryInterface.addIndex('worker_assignments', ['tenant_id', 'user_id', 'status']);
    await queryInterface.addIndex('worker_assignments', ['tenant_id', 'geography_id', 'status']);
    await queryInterface.addIndex('worker_assignments', ['tenant_id', 'facility_id', 'status']);
    await queryInterface.addIndex('worker_assignments', ['tenant_id', 'toilet_unit_id', 'status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('worker_assignments');
    await queryInterface.removeIndex('platform_users', 'platform_users_tenant_employee_code_uk');
    await queryInterface.removeColumn('platform_users', 'employee_code');
    await queryInterface.removeColumn('platform_users', 'metadata');
  },
};
