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

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((index) => index.name === indexName)) {
    await queryInterface.addIndex(tableName, fields, { ...options, name: indexName });
  }
};

const removeIndexIfPresent = async (queryInterface, tableName, indexName) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some((index) => index.name === indexName)) {
    await queryInterface.removeIndex(tableName, indexName);
  }
};

module.exports = {
  async up(queryInterface) {
    if (await tableExists(queryInterface, 'toilet_units')) {
      if (!(await columnExists(queryInterface, 'toilet_units', 'is_public_visible'))) {
        await queryInterface.addColumn('toilet_units', 'is_public_visible', {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        });
      }
      await addIndexIfMissing(
        queryInterface,
        'toilet_units',
        'toilet_units_public_visible_idx',
        ['is_public_visible']
      );
    }

    if (!(await tableExists(queryInterface, 'api_projects'))) {
      await queryInterface.createTable('api_projects', {
        id: uuidPk,
        project_name: { type: DataTypes.STRING(220), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        client_name: { type: DataTypes.STRING(220), allowNull: true },
        usage_by: { type: DataTypes.STRING(220), allowNull: true },
        project_owner_name: { type: DataTypes.STRING(180), allowNull: true },
        project_owner_email: { type: DataTypes.STRING(180), allowNull: true },
        project_owner_mobile: { type: DataTypes.STRING(32), allowNull: true },
        environment: {
          type: DataTypes.ENUM('sandbox', 'production'),
          allowNull: false,
          defaultValue: 'sandbox',
        },
        status: {
          type: DataTypes.ENUM('active', 'inactive', 'suspended'),
          allowNull: false,
          defaultValue: 'active',
        },
        allowed_tenant_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        created_by_super_admin_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        ...timestamps,
      });
    }
    await addIndexIfMissing(queryInterface, 'api_projects', 'api_projects_status_idx', ['status']);
    await addIndexIfMissing(queryInterface, 'api_projects', 'api_projects_environment_idx', ['environment']);

    if (!(await tableExists(queryInterface, 'api_keys'))) {
      await queryInterface.createTable('api_keys', {
        id: uuidPk,
        api_project_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'api_projects', key: 'id' },
          onDelete: 'CASCADE',
        },
        key_name: { type: DataTypes.STRING(180), allowNull: false },
        key_prefix: { type: DataTypes.STRING(32), allowNull: false, unique: true },
        api_key_hash: { type: DataTypes.STRING(128), allowNull: false, unique: true },
        environment: {
          type: DataTypes.ENUM('sandbox', 'production'),
          allowNull: false,
          defaultValue: 'sandbox',
        },
        status: {
          type: DataTypes.ENUM('active', 'inactive', 'revoked', 'expired'),
          allowNull: false,
          defaultValue: 'active',
        },
        permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        allowed_endpoints: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        allowed_tenant_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        allowed_origins: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        allowed_ips: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        rate_limit_per_minute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
        rate_limit_per_day: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1000 },
        monthly_quota: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30000 },
        expires_at: { type: DataTypes.DATE, allowNull: true },
        last_used_at: { type: DataTypes.DATE, allowNull: true },
        created_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
        revoked_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        revoke_reason: { type: DataTypes.TEXT, allowNull: true },
        ...timestamps,
      });
    }
    await addIndexIfMissing(queryInterface, 'api_keys', 'api_keys_project_idx', ['api_project_id']);
    await addIndexIfMissing(queryInterface, 'api_keys', 'api_keys_status_idx', ['status']);
    await addIndexIfMissing(queryInterface, 'api_keys', 'api_keys_key_prefix_idx', ['key_prefix']);

    if (!(await tableExists(queryInterface, 'api_usage_logs'))) {
      await queryInterface.createTable('api_usage_logs', {
        id: uuidPk,
        api_project_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'api_projects', key: 'id' },
          onDelete: 'SET NULL',
        },
        api_key_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'api_keys', key: 'id' },
          onDelete: 'SET NULL',
        },
        endpoint: { type: DataTypes.STRING(240), allowNull: false },
        method: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'GET' },
        request_ip: { type: DataTypes.STRING(80), allowNull: true },
        user_agent: { type: DataTypes.STRING(500), allowNull: true },
        lat_rounded: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
        lng_rounded: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
        radius: { type: DataTypes.INTEGER, allowNull: true },
        response_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        status_code: { type: DataTypes.INTEGER, allowNull: false },
        error_code: { type: DataTypes.STRING(120), allowNull: true },
        error_message: { type: DataTypes.STRING(1000), allowNull: true },
        response_time_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    }
    await addIndexIfMissing(queryInterface, 'api_usage_logs', 'api_usage_logs_project_key_created_idx', ['api_project_id', 'api_key_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'api_usage_logs', 'api_usage_logs_key_created_idx', ['api_key_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'api_usage_logs', 'api_usage_logs_error_ip_created_idx', ['error_code', 'request_ip', 'created_at']);

    if (!(await tableExists(queryInterface, 'api_usage_daily_summary'))) {
      await queryInterface.createTable('api_usage_daily_summary', {
        id: uuidPk,
        api_project_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'api_projects', key: 'id' },
          onDelete: 'CASCADE',
        },
        api_key_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'api_keys', key: 'id' },
          onDelete: 'CASCADE',
        },
        date: { type: DataTypes.DATEONLY, allowNull: false },
        total_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        successful_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        failed_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        rate_limited_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        avg_response_time_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        p95_response_time_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        total_toilets_returned: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        unique_ips_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        ...timestamps,
      });
    }
    await addIndexIfMissing(
      queryInterface,
      'api_usage_daily_summary',
      'api_usage_daily_summary_project_key_date_uk',
      ['api_project_id', 'api_key_id', 'date'],
      { unique: true }
    );

    if (!(await tableExists(queryInterface, 'api_key_events'))) {
      await queryInterface.createTable('api_key_events', {
        id: uuidPk,
        api_project_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'api_projects', key: 'id' },
          onDelete: 'SET NULL',
        },
        api_key_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'api_keys', key: 'id' },
          onDelete: 'SET NULL',
        },
        event_type: { type: DataTypes.STRING(120), allowNull: false },
        actor_user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        request_ip: { type: DataTypes.STRING(80), allowNull: true },
        user_agent: { type: DataTypes.STRING(500), allowNull: true },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    }
    await addIndexIfMissing(queryInterface, 'api_key_events', 'api_key_events_project_created_idx', ['api_project_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'api_key_events', 'api_key_events_key_created_idx', ['api_key_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'api_key_events', 'api_key_events_type_created_idx', ['event_type', 'created_at']);
  },

  async down(queryInterface) {
    await removeIndexIfPresent(queryInterface, 'api_key_events', 'api_key_events_type_created_idx');
    await removeIndexIfPresent(queryInterface, 'api_key_events', 'api_key_events_key_created_idx');
    await removeIndexIfPresent(queryInterface, 'api_key_events', 'api_key_events_project_created_idx');
    if (await tableExists(queryInterface, 'api_key_events')) await queryInterface.dropTable('api_key_events');

    await removeIndexIfPresent(queryInterface, 'api_usage_daily_summary', 'api_usage_daily_summary_project_key_date_uk');
    if (await tableExists(queryInterface, 'api_usage_daily_summary')) await queryInterface.dropTable('api_usage_daily_summary');

    await removeIndexIfPresent(queryInterface, 'api_usage_logs', 'api_usage_logs_error_ip_created_idx');
    await removeIndexIfPresent(queryInterface, 'api_usage_logs', 'api_usage_logs_key_created_idx');
    await removeIndexIfPresent(queryInterface, 'api_usage_logs', 'api_usage_logs_project_key_created_idx');
    if (await tableExists(queryInterface, 'api_usage_logs')) await queryInterface.dropTable('api_usage_logs');

    await removeIndexIfPresent(queryInterface, 'api_keys', 'api_keys_key_prefix_idx');
    await removeIndexIfPresent(queryInterface, 'api_keys', 'api_keys_status_idx');
    await removeIndexIfPresent(queryInterface, 'api_keys', 'api_keys_project_idx');
    if (await tableExists(queryInterface, 'api_keys')) await queryInterface.dropTable('api_keys');

    await removeIndexIfPresent(queryInterface, 'api_projects', 'api_projects_environment_idx');
    await removeIndexIfPresent(queryInterface, 'api_projects', 'api_projects_status_idx');
    if (await tableExists(queryInterface, 'api_projects')) await queryInterface.dropTable('api_projects');

    await removeIndexIfPresent(queryInterface, 'toilet_units', 'toilet_units_public_visible_idx');
    if (await columnExists(queryInterface, 'toilet_units', 'is_public_visible')) {
      await queryInterface.removeColumn('toilet_units', 'is_public_visible');
    }
  },
};
