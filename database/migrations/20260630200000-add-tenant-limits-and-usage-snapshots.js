'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ─── 1. tenant_limits ───────────────────────────────────────────────────
    await queryInterface.createTable('tenant_limits', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      // Master toggle — if false, all limits are ignored
      limits_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Storage
      storage_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      storage_limit_bytes: { type: Sequelize.BIGINT, allowNull: true },
      storage_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // AI tokens
      ai_token_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      ai_token_limit: { type: Sequelize.BIGINT, allowNull: true },
      ai_token_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // AI requests (fallback when tokens are not tracked per-provider)
      ai_request_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      ai_request_limit: { type: Sequelize.INTEGER, allowNull: true },
      ai_request_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Users
      user_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      user_limit: { type: Sequelize.INTEGER, allowNull: true },
      user_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Toilets
      toilet_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      toilet_limit: { type: Sequelize.INTEGER, allowNull: true },
      toilet_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Facilities / sites
      facility_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      facility_limit: { type: Sequelize.INTEGER, allowNull: true },
      facility_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Devices
      device_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      device_limit: { type: Sequelize.INTEGER, allowNull: true },
      device_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Inspections per month
      inspection_limit_enabled: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      inspection_limit: { type: Sequelize.INTEGER, allowNull: true },
      inspection_hard_block: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },

      // Notification preferences
      quota_warning_75_enabled: { type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      quota_warning_90_enabled: { type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      quota_exhausted_enabled: { type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      notify_tenant_admin: { type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      notify_super_admin: { type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
    });

    await queryInterface.addIndex('tenant_limits', ['tenant_id'], { name: 'idx_tenant_limits_tenant_id' });

    // ─── 2. tenant_usage_snapshots ─────────────────────────────────────────
    await queryInterface.createTable('tenant_usage_snapshots', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      calculated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },

      // Storage (calculated from inspection_media.content_length)
      storage_used_bytes: { type: Sequelize.BIGINT, allowNull: true },
      storage_object_count: { type: Sequelize.BIGINT, allowNull: true },
      image_count: { type: Sequelize.INTEGER, allowNull: true },
      average_image_size_bytes: { type: Sequelize.BIGINT, allowNull: true },
      largest_file_bytes: { type: Sequelize.BIGINT, allowNull: true },
      latest_upload_at: { type: Sequelize.DATE, allowNull: true },

      // AI (last 30 days from ai_usage_logs)
      ai_requests_30d: { type: Sequelize.INTEGER, allowNull: true },
      ai_tokens_30d: { type: Sequelize.BIGINT, allowNull: true },
      ai_cost_usd_30d: { type: Sequelize.DECIMAL(12, 6), allowNull: true },
      ai_failed_30d: { type: Sequelize.INTEGER, allowNull: true },

      // Headcounts (from DB counts at snapshot time)
      users_count: { type: Sequelize.INTEGER, allowNull: true },
      active_users_count: { type: Sequelize.INTEGER, allowNull: true },
      workers_count: { type: Sequelize.INTEGER, allowNull: true },
      toilets_count: { type: Sequelize.INTEGER, allowNull: true },
      facilities_count: { type: Sequelize.INTEGER, allowNull: true },
      devices_count: { type: Sequelize.INTEGER, allowNull: true },
      inspections_count: { type: Sequelize.INTEGER, allowNull: true },
      inspections_30d: { type: Sequelize.INTEGER, allowNull: true },
      open_alerts_count: { type: Sequelize.INTEGER, allowNull: true },
      failed_uploads_count: { type: Sequelize.INTEGER, allowNull: true },

      // Snapshot metadata
      source: {
        type: Sequelize.ENUM('db_metadata', 's3_scan', 'mixed'),
        allowNull: false,
        defaultValue: 'db_metadata',
      },
      status: {
        type: Sequelize.ENUM('fresh', 'stale', 'failed'),
        allowNull: false,
        defaultValue: 'fresh',
      },
      error_message: { type: Sequelize.TEXT, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('tenant_usage_snapshots', ['tenant_id', 'calculated_at'], {
      name: 'idx_tenant_usage_snapshots_tenant_calc',
    });
    await queryInterface.addIndex('tenant_usage_snapshots', ['tenant_id'], {
      name: 'idx_tenant_usage_snapshots_tenant',
    });

    // ─── 3. tenant_quota_notifications ─────────────────────────────────────
    await queryInterface.createTable('tenant_quota_notifications', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      resource: { type: Sequelize.STRING(60), allowNull: false },
      threshold: { type: Sequelize.INTEGER, allowNull: false },
      usage_percentage: { type: Sequelize.DECIMAL(6, 2), allowNull: true },
      limit_value: { type: Sequelize.BIGINT, allowNull: true },
      used_value: { type: Sequelize.BIGINT, allowNull: true },
      notification_sent_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      recipients: { type: Sequelize.JSONB, allowNull: true },
      status: { type: Sequelize.STRING(40), defaultValue: 'sent', allowNull: false },
      reset_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('tenant_quota_notifications', ['tenant_id', 'resource', 'threshold'], {
      name: 'idx_tenant_quota_notif_lookup',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tenant_quota_notifications');
    await queryInterface.dropTable('tenant_usage_snapshots');
    await queryInterface.dropTable('tenant_limits');
  },
};
