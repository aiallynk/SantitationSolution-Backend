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
    await queryInterface.createTable('tenants', {
      id: uuidPk,
      name: { type: DataTypes.STRING(200), allowNull: false },
      code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
      country_code: { type: DataTypes.STRING(10), allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('geographies', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      parent_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onDelete: 'SET NULL',
      },
      level: {
        type: DataTypes.ENUM('country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'),
        allowNull: false,
      },
      code: { type: DataTypes.STRING(120), allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: false },
      centroid_latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      centroid_longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('geographies', ['tenant_id', 'level']);
    await queryInterface.addIndex('geographies', ['parent_id']);
    await queryInterface.addConstraint('geographies', {
      type: 'unique',
      fields: ['tenant_id', 'level', 'code'],
      name: 'geographies_tenant_level_code_uk',
    });

    await queryInterface.createTable('platform_users', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      geography_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onDelete: 'SET NULL',
      },
      full_name: { type: DataTypes.STRING(180), allowNull: false },
      email: { type: DataTypes.STRING(180), allowNull: false, unique: true },
      phone: { type: DataTypes.STRING(32), allowNull: true, unique: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: true },
      auth_provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'local' },
      status: { type: DataTypes.ENUM('active', 'inactive', 'locked'), allowNull: false, defaultValue: 'active' },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('platform_users', ['tenant_id', 'status']);

    await queryInterface.createTable('roles', {
      id: uuidPk,
      code: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(180), allowNull: false },
      description: { type: DataTypes.STRING(400), allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('permissions', {
      id: uuidPk,
      code: { type: DataTypes.STRING(150), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(180), allowNull: false },
      description: { type: DataTypes.STRING(400), allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('role_permissions', {
      id: uuidPk,
      role_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onDelete: 'CASCADE',
      },
      permission_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'permissions', key: 'id' },
        onDelete: 'CASCADE',
      },
      ...timestamps,
    });
    await queryInterface.addConstraint('role_permissions', {
      type: 'unique',
      fields: ['role_id', 'permission_id'],
      name: 'role_permissions_role_permission_uk',
    });

    await queryInterface.createTable('user_roles', {
      id: uuidPk,
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'CASCADE',
      },
      role_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onDelete: 'CASCADE',
      },
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      geography_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onDelete: 'SET NULL',
      },
      ...timestamps,
    });
    await queryInterface.addConstraint('user_roles', {
      type: 'unique',
      fields: ['user_id', 'role_id', 'tenant_id', 'geography_id'],
      name: 'user_roles_scope_uk',
    });

    await queryInterface.createTable('facilities', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      geography_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onDelete: 'SET NULL',
      },
      code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(220), allowNull: false },
      facility_type: { type: DataTypes.STRING(80), allowNull: false },
      address_line: { type: DataTypes.STRING(300), allowNull: true },
      latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      status: {
        type: DataTypes.ENUM('active', 'inactive', 'maintenance'),
        allowNull: false,
        defaultValue: 'active',
      },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('facilities', ['tenant_id', 'geography_id']);
    await queryInterface.addIndex('facilities', ['latitude', 'longitude']);

    await queryInterface.createTable('toilet_blocks', {
      id: uuidPk,
      facility_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'CASCADE',
      },
      code: { type: DataTypes.STRING(120), allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: false },
      gender_type: { type: DataTypes.STRING(40), allowNull: true },
      status: { type: DataTypes.ENUM('active', 'inactive', 'maintenance'), allowNull: false, defaultValue: 'active' },
      ...timestamps,
    });
    await queryInterface.addConstraint('toilet_blocks', {
      type: 'unique',
      fields: ['facility_id', 'code'],
      name: 'toilet_blocks_facility_code_uk',
    });

    await queryInterface.createTable('toilet_units', {
      id: uuidPk,
      facility_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'CASCADE',
      },
      toilet_block_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'toilet_blocks', key: 'id' },
        onDelete: 'CASCADE',
      },
      code: { type: DataTypes.STRING(120), allowNull: false },
      unit_type: { type: DataTypes.STRING(40), allowNull: false },
      status: {
        type: DataTypes.ENUM('clean', 'moderate', 'poor', 'critical', 'out_of_service'),
        allowNull: false,
        defaultValue: 'moderate',
      },
      ...timestamps,
    });
    await queryInterface.addConstraint('toilet_units', {
      type: 'unique',
      fields: ['toilet_block_id', 'code'],
      name: 'toilet_units_block_code_uk',
    });

    await queryInterface.createTable('inspection_tasks', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      facility_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'CASCADE',
      },
      toilet_unit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'toilet_units', key: 'id' },
        onDelete: 'SET NULL',
      },
      assigned_to_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'RESTRICT',
      },
      task_type: { type: DataTypes.STRING(50), allowNull: false },
      scheduled_at: { type: DataTypes.DATE, allowNull: false },
      sla_minutes: { type: DataTypes.INTEGER, allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'in_progress', 'completed', 'cancelled', 'overdue'),
        allowNull: false,
        defaultValue: 'pending',
      },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('inspection_tasks', ['assigned_to_user_id', 'status', 'scheduled_at']);

    await queryInterface.createTable('inspections', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      task_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'inspection_tasks', key: 'id' },
        onDelete: 'SET NULL',
      },
      facility_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'CASCADE',
      },
      toilet_unit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'toilet_units', key: 'id' },
        onDelete: 'SET NULL',
      },
      inspector_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'RESTRICT',
      },
      inspection_type: {
        type: DataTypes.ENUM('before_cleaning', 'after_cleaning', 'surprise_audit', 'complaint_based'),
        allowNull: false,
        defaultValue: 'before_cleaning',
      },
      notes: { type: DataTypes.STRING(1000), allowNull: true },
      latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      captured_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      submitted_at: { type: DataTypes.DATE, allowNull: true },
      processing_status: {
        type: DataTypes.ENUM('draft', 'queued', 'processing', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'draft',
      },
      overall_status: { type: DataTypes.ENUM('clean', 'moderate', 'poor', 'critical'), allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('inspections', ['tenant_id', 'captured_at']);
    await queryInterface.addIndex('inspections', ['processing_status']);
    await queryInterface.addIndex('inspections', ['facility_id', 'toilet_unit_id']);

    await queryInterface.createTable('inspection_media', {
      id: uuidPk,
      inspection_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'inspections', key: 'id' },
        onDelete: 'SET NULL',
      },
      media_type: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'image' },
      capture_stage: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'evidence' },
      file_url: { type: DataTypes.STRING(500), allowNull: true },
      storage_key: { type: DataTypes.STRING(500), allowNull: true },
      thumbnail_url: { type: DataTypes.STRING(500), allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      uploaded_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('inspection_media', ['inspection_id', 'capture_stage']);

    await queryInterface.createTable('ai_analysis_results', {
      id: uuidPk,
      inspection_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'inspections', key: 'id' },
        onDelete: 'CASCADE',
      },
      model_name: { type: DataTypes.STRING(120), allowNull: false },
      model_version: { type: DataTypes.STRING(80), allowNull: false },
      cleanliness_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      hygiene_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      odor_risk_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      wetness_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      stain_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      litter_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      anomaly_flags: { type: DataTypes.JSONB, allowNull: true },
      raw_result: { type: DataTypes.JSONB, allowNull: true },
      processed_at: { type: DataTypes.DATE, allowNull: false },
      ...timestamps,
    });
    await queryInterface.addIndex('ai_analysis_results', ['inspection_id', 'processed_at']);

    await queryInterface.createTable('sensor_devices', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      facility_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'SET NULL',
      },
      toilet_block_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'toilet_blocks', key: 'id' },
        onDelete: 'SET NULL',
      },
      toilet_unit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'toilet_units', key: 'id' },
        onDelete: 'SET NULL',
      },
      device_id: { type: DataTypes.STRING(140), allowNull: false, unique: true },
      serial_no: { type: DataTypes.STRING(140), allowNull: true },
      device_type: { type: DataTypes.STRING(60), allowNull: false },
      status: { type: DataTypes.ENUM('active', 'inactive', 'faulty'), allowNull: false, defaultValue: 'active' },
      firmware_version: { type: DataTypes.STRING(80), allowNull: true },
      last_seen_at: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('sensor_devices', ['tenant_id', 'status']);
    await queryInterface.addIndex('sensor_devices', ['facility_id']);

    await queryInterface.createTable('sensor_readings', {
      id: uuidPk,
      device_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'sensor_devices', key: 'id' },
        onDelete: 'CASCADE',
      },
      timestamp: { type: DataTypes.DATE, allowNull: false },
      odor_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      ammonia_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      h2s_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      methane_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      humidity: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      temperature: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      occupancy_count: { type: DataTypes.INTEGER, allowNull: true },
      footfall_count: { type: DataTypes.INTEGER, allowNull: true },
      tank_fill_level: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      battery_level: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      signal_strength: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      raw_payload: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('sensor_readings', ['device_id', 'timestamp']);

    await queryInterface.createTable('alerts', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      alert_type: { type: DataTypes.STRING(80), allowNull: false },
      severity: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false },
      source_type: { type: DataTypes.ENUM('sensor', 'ai_analysis', 'manual', 'system'), allowNull: false },
      source_id: { type: DataTypes.UUID, allowNull: true },
      facility_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'SET NULL',
      },
      message: { type: DataTypes.STRING(600), allowNull: false },
      status: { type: DataTypes.ENUM('open', 'acknowledged', 'resolved'), allowNull: false, defaultValue: 'open' },
      assigned_to_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      acknowledged_at: { type: DataTypes.DATE, allowNull: true },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('alerts', ['tenant_id', 'status', 'severity']);
    await queryInterface.addIndex('alerts', ['facility_id', 'created_at']);

    await queryInterface.createTable('cleaning_events', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      facility_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'facilities', key: 'id' },
        onDelete: 'CASCADE',
      },
      toilet_unit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'toilet_units', key: 'id' },
        onDelete: 'SET NULL',
      },
      worker_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'RESTRICT',
      },
      start_time: { type: DataTypes.DATE, allowNull: false },
      end_time: { type: DataTypes.DATE, allowNull: true },
      method: { type: DataTypes.STRING(120), allowNull: true },
      chemical_used: { type: DataTypes.STRING(120), allowNull: true },
      remarks: { type: DataTypes.STRING(600), allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('complaints', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
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
      reporter_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      complaint_type: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.STRING(1000), allowNull: false },
      status: { type: DataTypes.ENUM('open', 'assigned', 'resolved', 'rejected'), allowNull: false, defaultValue: 'open' },
      assigned_to_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      priority: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false, defaultValue: 'medium' },
      ...timestamps,
    });
    await queryInterface.addIndex('complaints', ['tenant_id', 'status', 'priority']);

    await queryInterface.createTable('notification_events', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      event_type: { type: DataTypes.STRING(120), allowNull: false },
      channel: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'in_app' },
      payload: { type: DataTypes.JSONB, allowNull: false },
      status: { type: DataTypes.ENUM('queued', 'sent', 'failed'), allowNull: false, defaultValue: 'queued' },
      sent_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('audit_logs', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      actor_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      action: { type: DataTypes.STRING(120), allowNull: false },
      entity_type: { type: DataTypes.STRING(120), allowNull: false },
      entity_id: { type: DataTypes.STRING(120), allowNull: true },
      request_id: { type: DataTypes.STRING(120), allowNull: true },
      ip_address: { type: DataTypes.STRING(60), allowNull: true },
      user_agent: { type: DataTypes.STRING(400), allowNull: true },
      details: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('audit_logs', ['tenant_id', 'created_at']);
    await queryInterface.addIndex('audit_logs', ['actor_user_id']);

    await queryInterface.createTable('login_sessions', {
      id: uuidPk,
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'CASCADE',
      },
      refresh_token_hash: { type: DataTypes.STRING(255), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      ip_address: { type: DataTypes.STRING(60), allowNull: true },
      user_agent: { type: DataTypes.STRING(400), allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('login_sessions', ['user_id', 'expires_at']);

    await queryInterface.createTable('dashboard_aggregates', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
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
      aggregate_date: { type: DataTypes.DATEONLY, allowNull: false },
      metrics: { type: DataTypes.JSONB, allowNull: false },
      ...timestamps,
    });
    await queryInterface.addConstraint('dashboard_aggregates', {
      type: 'unique',
      fields: ['tenant_id', 'geography_id', 'facility_id', 'aggregate_date'],
      name: 'dashboard_aggregates_scope_uk',
    });

    await queryInterface.createTable('storage_usage_metrics', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      bucket_name: { type: DataTypes.STRING(180), allowNull: false },
      used_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      object_count: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      measured_at: { type: DataTypes.DATE, allowNull: false },
      ...timestamps,
    });
    await queryInterface.addIndex('storage_usage_metrics', ['tenant_id', 'measured_at']);

    await queryInterface.createTable('integration_configs', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      name: { type: DataTypes.STRING(180), allowNull: false },
      config_type: { type: DataTypes.STRING(120), allowNull: false },
      config_json: { type: DataTypes.JSONB, allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...timestamps,
    });
    await queryInterface.addIndex('integration_configs', ['tenant_id', 'config_type']);

    await queryInterface.createTable('password_reset_tokens', {
      id: uuidPk,
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'CASCADE',
      },
      token_hash: { type: DataTypes.STRING(255), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('password_reset_tokens', ['user_id', 'expires_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('password_reset_tokens');
    await queryInterface.dropTable('integration_configs');
    await queryInterface.dropTable('storage_usage_metrics');
    await queryInterface.dropTable('dashboard_aggregates');
    await queryInterface.dropTable('login_sessions');
    await queryInterface.dropTable('audit_logs');
    await queryInterface.dropTable('notification_events');
    await queryInterface.dropTable('complaints');
    await queryInterface.dropTable('cleaning_events');
    await queryInterface.dropTable('alerts');
    await queryInterface.dropTable('sensor_readings');
    await queryInterface.dropTable('sensor_devices');
    await queryInterface.dropTable('ai_analysis_results');
    await queryInterface.dropTable('inspection_media');
    await queryInterface.dropTable('inspections');
    await queryInterface.dropTable('inspection_tasks');
    await queryInterface.dropTable('toilet_units');
    await queryInterface.dropTable('toilet_blocks');
    await queryInterface.dropTable('facilities');
    await queryInterface.dropTable('user_roles');
    await queryInterface.dropTable('role_permissions');
    await queryInterface.dropTable('permissions');
    await queryInterface.dropTable('roles');
    await queryInterface.dropTable('platform_users');
    await queryInterface.dropTable('geographies');
    await queryInterface.dropTable('tenants');
  },
};
