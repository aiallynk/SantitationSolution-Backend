'use strict';

const crypto = require('crypto');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = new Date();

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          WHERE t.typname = 'enum_platform_users_status'
            AND e.enumlabel = 'pending_activation'
        ) THEN
          ALTER TYPE "enum_platform_users_status" ADD VALUE 'pending_activation';
        END IF;
      END
      $$;
    `);

    await queryInterface.addColumn('password_reset_tokens', 'purpose', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'password_reset',
    });
    await queryInterface.addColumn('password_reset_tokens', 'delivery_channel', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await queryInterface.addColumn('password_reset_tokens', 'metadata', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await queryInterface.addIndex('password_reset_tokens', ['user_id', 'purpose', 'expires_at'], {
      name: 'password_reset_tokens_user_purpose_expires_idx',
    });

    const permissionRows = [
      ['worker.bulk_import.template', 'Download worker import template'],
      ['worker.bulk_import.validate', 'Validate worker import files'],
      ['worker.bulk_import.confirm', 'Confirm worker imports'],
      ['worker.bulk_import.history', 'View worker import history'],
    ].map(([code, name], index) => ({
      id: crypto.randomUUID(),
      code,
      name,
      description: name,
      created_at: now,
      updated_at: now,
    }));
    await queryInterface.bulkInsert('permissions', permissionRows);
    const [roleRows, permissionLookupRows] = await Promise.all([
      queryInterface.sequelize.query(
        `SELECT id, code FROM roles WHERE code IN (
          'super_admin',
          'tenant_admin',
          'country_admin',
          'state_admin',
          'district_admin',
          'city_admin',
          'zone_admin'
        )`,
        { type: Sequelize.QueryTypes.SELECT }
      ),
      queryInterface.sequelize.query(
        `SELECT id, code FROM permissions WHERE code IN (
          'worker.bulk_import.template',
          'worker.bulk_import.validate',
          'worker.bulk_import.confirm',
          'worker.bulk_import.history'
        )`,
        { type: Sequelize.QueryTypes.SELECT }
      ),
    ]);
    const rolePermissionRows = [];
    for (const roleRow of roleRows) {
      for (const permissionRow of permissionLookupRows) {
        rolePermissionRows.push({
          id: crypto.randomUUID(),
          role_id: roleRow.id,
          permission_id: permissionRow.id,
          created_at: now,
          updated_at: now,
        });
      }
    }
    if (rolePermissionRows.length > 0) {
      await queryInterface.bulkInsert('role_permissions', rolePermissionRows, { ignoreDuplicates: true });
    }

    await queryInterface.createTable('worker_import_jobs', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      uploaded_by: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'RESTRICT',
      },
      uploader_scope_type: { type: DataTypes.STRING(40), allowNull: true },
      uploader_scope_id: { type: DataTypes.UUID, allowNull: true },
      original_file_name: { type: DataTypes.STRING(255), allowNull: false },
      file_checksum: { type: DataTypes.STRING(128), allowNull: false },
      total_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      valid_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      invalid_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      duplicate_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      warning_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed_rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: 'UPLOADED',
      },
      summary: { type: DataTypes.JSONB, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('worker_import_jobs', ['tenant_id', 'created_at'], {
      name: 'worker_import_jobs_tenant_created_idx',
    });
    await queryInterface.addIndex('worker_import_jobs', ['tenant_id', 'file_checksum'], {
      name: 'worker_import_jobs_tenant_checksum_idx',
    });

    await queryInterface.createTable('worker_import_rows', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      import_job_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'worker_import_jobs', key: 'id' },
        onDelete: 'CASCADE',
      },
      row_number: { type: DataTypes.INTEGER, allowNull: false },
      employee_code: { type: DataTypes.STRING(64), allowNull: true },
      normalized_payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'PENDING' },
      validation_errors: { type: DataTypes.JSONB, allowNull: true },
      created_worker_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('worker_import_rows', ['import_job_id', 'row_number'], {
      name: 'worker_import_rows_job_row_idx',
      unique: true,
    });
    await queryInterface.addIndex('worker_import_rows', ['import_job_id', 'status'], {
      name: 'worker_import_rows_job_status_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('worker_import_rows');
    await queryInterface.dropTable('worker_import_jobs');
    await queryInterface.removeIndex('password_reset_tokens', 'password_reset_tokens_user_purpose_expires_idx');
    await queryInterface.removeColumn('password_reset_tokens', 'metadata');
    await queryInterface.removeColumn('password_reset_tokens', 'delivery_channel');
    await queryInterface.removeColumn('password_reset_tokens', 'purpose');
    await queryInterface.sequelize.query(`
      DELETE FROM role_permissions
      WHERE permission_id IN (
        SELECT id FROM permissions WHERE code IN (
          'worker.bulk_import.template',
          'worker.bulk_import.validate',
          'worker.bulk_import.confirm',
          'worker.bulk_import.history'
        )
      );
    `);
    await queryInterface.bulkDelete('permissions', {
      code: [
        'worker.bulk_import.template',
        'worker.bulk_import.validate',
        'worker.bulk_import.confirm',
        'worker.bulk_import.history',
      ],
    });
  },
};
