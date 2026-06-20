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

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((idx) => idx.name === indexName)) {
    await queryInterface.addIndex(tableName, fields, { ...options, name: indexName });
  }
};

const addCheck = async (queryInterface, tableName, constraintName, expression) => {
  await queryInterface.sequelize.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = '${constraintName}'
      ) THEN
        ALTER TABLE ${tableName}
          ADD CONSTRAINT ${constraintName} CHECK (${expression});
      END IF;
    END $$;
  `);
};

const enableGuardedRls = async (queryInterface, tableName) => {
  await queryInterface.sequelize.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`);
  await queryInterface.sequelize.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'CREATE POLICY ${tableName}_anon_deny ON ${tableName} FOR ALL TO anon USING (false) WITH CHECK (false)';
      END IF;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);
  await queryInterface.sequelize.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'CREATE POLICY ${tableName}_authenticated_deny ON ${tableName} FOR ALL TO authenticated USING (false) WITH CHECK (false)';
      END IF;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);
};

module.exports = {
  async up(queryInterface) {
    if (!(await tableExists(queryInterface, 'backup_schedules'))) {
      await queryInterface.createTable('backup_schedules', {
        id: uuidPk,
        scope: { type: DataTypes.STRING(20), allowNull: false },
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
        },
        frequency: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'daily' },
        cron_expression: { type: DataTypes.STRING(120), allowNull: true },
        timezone: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'Asia/Kolkata' },
        run_time: { type: DataTypes.TIME, allowNull: true },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        retention_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
        include_storage_metadata: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        include_storage_files: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        created_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        updated_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        last_run_at: { type: DataTypes.DATE, allowNull: true },
        next_run_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      });
    }

    if (!(await tableExists(queryInterface, 'backup_jobs'))) {
      await queryInterface.createTable('backup_jobs', {
        id: uuidPk,
        schedule_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'backup_schedules', key: 'id' },
          onDelete: 'SET NULL',
        },
        scope: { type: DataTypes.STRING(20), allowNull: false },
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'SET NULL',
        },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
        triggered_by: { type: DataTypes.STRING(20), allowNull: false },
        requested_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        started_at: { type: DataTypes.DATE, allowNull: true },
        completed_at: { type: DataTypes.DATE, allowNull: true },
        duration_ms: { type: DataTypes.INTEGER, allowNull: true },
        file_path: { type: DataTypes.STRING(700), allowNull: true },
        file_name: { type: DataTypes.STRING(260), allowNull: true },
        file_size_bytes: { type: DataTypes.BIGINT, allowNull: true },
        checksum_sha256: { type: DataTypes.STRING(128), allowNull: true },
        error_message: { type: DataTypes.STRING(2000), allowNull: true },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    }

    if (!(await tableExists(queryInterface, 'backup_files'))) {
      await queryInterface.createTable('backup_files', {
        id: uuidPk,
        backup_job_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'backup_jobs', key: 'id' },
          onDelete: 'CASCADE',
        },
        storage_provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'local' },
        bucket_name: { type: DataTypes.STRING(180), allowNull: true },
        file_path: { type: DataTypes.STRING(700), allowNull: false },
        file_name: { type: DataTypes.STRING(260), allowNull: false },
        size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        checksum_sha256: { type: DataTypes.STRING(128), allowNull: true },
        content_type: { type: DataTypes.STRING(120), allowNull: false, defaultValue: 'application/zip' },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    }

    if (!(await tableExists(queryInterface, 'backup_audit_logs'))) {
      await queryInterface.createTable('backup_audit_logs', {
        id: uuidPk,
        action: { type: DataTypes.STRING(120), allowNull: false },
        actor_user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        backup_job_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'backup_jobs', key: 'id' },
          onDelete: 'SET NULL',
        },
        backup_schedule_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'backup_schedules', key: 'id' },
          onDelete: 'SET NULL',
        },
        scope: { type: DataTypes.STRING(20), allowNull: true },
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'SET NULL',
        },
        ip_address: { type: DataTypes.STRING(80), allowNull: true },
        user_agent: { type: DataTypes.STRING(500), allowNull: true },
        details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    }

    await addCheck(queryInterface, 'backup_schedules', 'backup_schedules_scope_ck', "scope IN ('full_db', 'tenant')");
    await addCheck(queryInterface, 'backup_schedules', 'backup_schedules_frequency_ck', "frequency IN ('daily')");
    await addCheck(
      queryInterface,
      'backup_schedules',
      'backup_schedules_tenant_scope_ck',
      "(scope = 'tenant' AND tenant_id IS NOT NULL) OR (scope = 'full_db' AND tenant_id IS NULL)"
    );
    await addCheck(queryInterface, 'backup_schedules', 'backup_schedules_retention_ck', 'retention_days BETWEEN 1 AND 365');

    await addCheck(queryInterface, 'backup_jobs', 'backup_jobs_scope_ck', "scope IN ('full_db', 'tenant')");
    await addCheck(queryInterface, 'backup_jobs', 'backup_jobs_status_ck', "status IN ('queued', 'running', 'success', 'failed', 'cancelled')");
    await addCheck(queryInterface, 'backup_jobs', 'backup_jobs_triggered_by_ck', "triggered_by IN ('manual', 'scheduled')");
    await addCheck(
      queryInterface,
      'backup_jobs',
      'backup_jobs_tenant_scope_ck',
      "(scope = 'tenant' AND tenant_id IS NOT NULL) OR (scope = 'full_db' AND tenant_id IS NULL)"
    );

    await addIndexIfMissing(queryInterface, 'backup_schedules', 'backup_schedules_enabled_next_run_idx', ['enabled', 'next_run_at']);
    await addIndexIfMissing(queryInterface, 'backup_schedules', 'backup_schedules_tenant_idx', ['tenant_id']);
    await addIndexIfMissing(queryInterface, 'backup_jobs', 'backup_jobs_status_created_idx', ['status', 'created_at']);
    await addIndexIfMissing(queryInterface, 'backup_jobs', 'backup_jobs_tenant_created_idx', ['tenant_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'backup_jobs', 'backup_jobs_schedule_created_idx', ['schedule_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'backup_files', 'backup_files_job_idx', ['backup_job_id']);
    await addIndexIfMissing(queryInterface, 'backup_audit_logs', 'backup_audit_logs_job_idx', ['backup_job_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'backup_audit_logs', 'backup_audit_logs_schedule_idx', ['backup_schedule_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'backup_audit_logs', 'backup_audit_logs_actor_idx', ['actor_user_id', 'created_at']);

    await enableGuardedRls(queryInterface, 'backup_schedules');
    await enableGuardedRls(queryInterface, 'backup_jobs');
    await enableGuardedRls(queryInterface, 'backup_files');
    await enableGuardedRls(queryInterface, 'backup_audit_logs');
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'backup_audit_logs')) {
      await queryInterface.dropTable('backup_audit_logs');
    }
    if (await tableExists(queryInterface, 'backup_files')) {
      await queryInterface.dropTable('backup_files');
    }
    if (await tableExists(queryInterface, 'backup_jobs')) {
      await queryInterface.dropTable('backup_jobs');
    }
    if (await tableExists(queryInterface, 'backup_schedules')) {
      await queryInterface.dropTable('backup_schedules');
    }
  },
};
