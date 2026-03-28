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
    await queryInterface.createTable('super_admin_projects', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      name: { type: DataTypes.STRING(220), allowNull: false },
      code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      category: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'deployment' },
      status: {
        type: DataTypes.ENUM('planned', 'active', 'on_hold', 'completed', 'cancelled'),
        allowNull: false,
        defaultValue: 'planned',
      },
      starts_at: { type: DataTypes.DATE, allowNull: true },
      ends_at: { type: DataTypes.DATE, allowNull: true },
      geography_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onDelete: 'SET NULL',
      },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('super_admin_projects', ['tenant_id', 'status']);
    await queryInterface.addIndex('super_admin_projects', ['geography_id']);

    await queryInterface.createTable('super_admin_approvals', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      requested_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      reviewed_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      category: { type: DataTypes.STRING(120), allowNull: false },
      entity_type: { type: DataTypes.STRING(120), allowNull: false },
      entity_id: { type: DataTypes.STRING(120), allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      notes: { type: DataTypes.STRING(800), allowNull: true },
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('super_admin_approvals', ['status', 'created_at']);
    await queryInterface.addIndex('super_admin_approvals', ['tenant_id', 'status']);

    await queryInterface.createTable('super_admin_support_tickets', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      opened_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      assigned_to_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      subject: { type: DataTypes.STRING(240), allowNull: false },
      description: { type: DataTypes.STRING(2000), allowNull: false },
      severity: {
        type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
        allowNull: false,
        defaultValue: 'medium',
      },
      status: {
        type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed'),
        allowNull: false,
        defaultValue: 'open',
      },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('super_admin_support_tickets', ['status', 'severity']);
    await queryInterface.addIndex('super_admin_support_tickets', ['tenant_id', 'status']);

    await queryInterface.createTable('super_admin_release_records', {
      id: uuidPk,
      version: { type: DataTypes.STRING(80), allowNull: false },
      environment: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'staging' },
      status: {
        type: DataTypes.ENUM('planned', 'running', 'success', 'failed', 'rolled_back'),
        allowNull: false,
        defaultValue: 'planned',
      },
      deployed_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      deployed_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.STRING(1200), allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('super_admin_release_records', ['environment', 'status', 'created_at']);

    await queryInterface.createTable('super_admin_backup_records', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      backup_type: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'database' },
      storage_key: { type: DataTypes.STRING(500), allowNull: true },
      size_bytes: { type: DataTypes.BIGINT, allowNull: true },
      status: {
        type: DataTypes.ENUM('queued', 'running', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      retention_until: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('super_admin_backup_records', ['status', 'created_at']);
    await queryInterface.addIndex('super_admin_backup_records', ['tenant_id', 'created_at']);

    await queryInterface.createTable('super_admin_sync_failures', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      source_module: { type: DataTypes.STRING(120), allowNull: false },
      reference_id: { type: DataTypes.STRING(180), allowNull: true },
      severity: {
        type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
        allowNull: false,
        defaultValue: 'medium',
      },
      reason: { type: DataTypes.STRING(1000), allowNull: false },
      payload: { type: DataTypes.JSONB, allowNull: true },
      status: {
        type: DataTypes.ENUM('open', 'resolved', 'ignored'),
        allowNull: false,
        defaultValue: 'open',
      },
      first_seen_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      last_seen_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('super_admin_sync_failures', ['status', 'severity', 'last_seen_at']);
    await queryInterface.addIndex('super_admin_sync_failures', ['tenant_id', 'status']);

    await queryInterface.createTable('super_admin_tenant_health', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      snapshot_at: { type: DataTypes.DATE, allowNull: false },
      health_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      open_alerts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      pending_tasks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed_syncs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      active_sensors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      total_sensors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addConstraint('super_admin_tenant_health', {
      type: 'unique',
      fields: ['tenant_id', 'snapshot_at'],
      name: 'super_admin_tenant_health_snapshot_uk',
    });
    await queryInterface.addIndex('super_admin_tenant_health', ['snapshot_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('super_admin_tenant_health');
    await queryInterface.dropTable('super_admin_sync_failures');
    await queryInterface.dropTable('super_admin_backup_records');
    await queryInterface.dropTable('super_admin_release_records');
    await queryInterface.dropTable('super_admin_support_tickets');
    await queryInterface.dropTable('super_admin_approvals');
    await queryInterface.dropTable('super_admin_projects');
  },
};
