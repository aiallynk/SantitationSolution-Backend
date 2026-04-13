'use strict';

const { DataTypes, Sequelize } = require('sequelize');

const addColumnIfMissing = async (queryInterface, table, column, definition) => {
  const description = await queryInterface.describeTable(table);
  if (!description[column]) {
    await queryInterface.addColumn(table, column, definition);
  }
};

const removeColumnIfExists = async (queryInterface, table, column) => {
  const description = await queryInterface.describeTable(table);
  if (description[column]) {
    await queryInterface.removeColumn(table, column);
  }
};

const addIndexSafe = async (queryInterface, table, fields, name, options = {}) => {
  try {
    await queryInterface.addIndex(table, fields, { name, ...options });
  } catch (_) {
    // no-op if already exists
  }
};

const removeIndexSafe = async (queryInterface, table, name) => {
  try {
    await queryInterface.removeIndex(table, name);
  } catch (_) {
    // no-op if missing
  }
};

const hasTable = async (queryInterface, table) => {
  try {
    await queryInterface.describeTable(table);
    return true;
  } catch (_) {
    return false;
  }
};

const ensureUuidFunctionAvailability = async (queryInterface) => {
  // Best effort: managed Postgres providers sometimes pre-enable only one extension.
  await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";').catch(() => {});
  await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";').catch(() => {});

  const [rows] = await queryInterface.sequelize.query(`
    SELECT CASE
      WHEN to_regprocedure('gen_random_uuid()') IS NOT NULL THEN 'gen_random_uuid()'
      WHEN to_regprocedure('uuid_generate_v4()') IS NOT NULL THEN 'uuid_generate_v4()'
      ELSE NULL
    END AS uuid_fn
  `);

  return rows?.[0]?.uuid_fn || null;
};

const fallbackDeterministicUuidExpression = (seedSql) => `
  (
    SUBSTR(MD5(${seedSql}), 1, 8) || '-' ||
    SUBSTR(MD5(${seedSql}), 9, 4) || '-' ||
    SUBSTR(MD5(${seedSql}), 13, 4) || '-' ||
    SUBSTR(MD5(${seedSql}), 17, 4) || '-' ||
    SUBSTR(MD5(${seedSql}), 21, 12)
  )::uuid
`;

const resolveInsertUuidExpression = (uuidFunctionExpression, fallbackSeedSql) => {
  if (uuidFunctionExpression) {
    return uuidFunctionExpression;
  }

  return fallbackDeterministicUuidExpression(fallbackSeedSql);
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const uuidFunctionExpression = await ensureUuidFunctionAvailability(queryInterface);

    await addColumnIfMissing(queryInterface, 'inspection_media', 'processing_state', {
      type: DataTypes.STRING(60),
      allowNull: false,
      defaultValue: 'captured',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'retry_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'ai_attempt_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'last_retry_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'next_retry_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'last_error_code', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'last_error_message', {
      type: DataTypes.STRING(2000),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'manual_review_required_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'storage_verified_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'inspections', 'pipeline_counters', {
      type: DataTypes.JSONB,
      allowNull: true,
    });

    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['inspection_id', 'processing_state'],
      'inspection_media_processing_state_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['processing_state', 'next_retry_at'],
      'inspection_media_state_next_retry_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['worker_id', 'processing_state'],
      'inspection_media_worker_state_idx'
    );

    await queryInterface.sequelize.query(`
      UPDATE inspection_media
      SET
        processing_state = CASE
          WHEN ai_status = 'AI_COMPLETED' THEN 'ai_completed'
          WHEN ai_status = 'AI_PROCESSING' THEN 'ai_processing'
          WHEN ai_status = 'AI_QUEUED' THEN 'queued_for_ai'
          WHEN ai_status = 'AI_FAILED' AND review_required = true THEN 'manual_review_required'
          WHEN ai_status = 'AI_FAILED' THEN 'ai_failed_permanent'
          WHEN upload_status IN ('confirmed', 'uploaded') THEN 'storage_verified'
          WHEN upload_status = 'upload_session_created' THEN 'queued_for_upload'
          WHEN upload_status = 'uploading' THEN 'uploading'
          ELSE 'captured'
        END,
        last_error_message = COALESCE(last_error_message, ai_error),
        updated_at = CURRENT_TIMESTAMP
    `);

    await addColumnIfMissing(queryInterface, 'image_sessions', 'reconcile_attempts', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'image_sessions', 'reconciled_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'image_sessions', 'last_reconcile_error', {
      type: DataTypes.STRING(1000),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'image_sessions', 'object_key_locked', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    await addIndexSafe(
      queryInterface,
      'image_sessions',
      ['status', 'upload_url_expires_at'],
      'image_sessions_status_upload_expiry_idx'
    );

    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'leased_until', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'last_heartbeat_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'failure_classification', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'dead_letter_reason', {
      type: DataTypes.STRING(1000),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'next_retry_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });

    await addIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      ['status', 'leased_until'],
      'ai_processing_jobs_status_lease_idx'
    );
    await addIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      ['status', 'next_retry_at'],
      'ai_processing_jobs_status_next_retry_idx'
    );

    const qrCodeTableExists = await hasTable(queryInterface, 'toilet_qr_codes');
    if (!qrCodeTableExists) {
      const idColumn = {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
      };
      if (uuidFunctionExpression) {
        idColumn.defaultValue = Sequelize.literal(uuidFunctionExpression);
      }

      await queryInterface.createTable('toilet_qr_codes', {
        id: idColumn,
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'SET NULL',
        },
        toilet_unit_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'toilet_units', key: 'id' },
          onDelete: 'CASCADE',
        },
        qr_code: {
          type: DataTypes.STRING(220),
          allowNull: false,
        },
        schema_version: {
          type: DataTypes.STRING(40),
          allowNull: false,
          defaultValue: 'legacy_v1',
        },
        qr_payload: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'active',
        },
        is_primary: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
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
      });
    }

    if (uuidFunctionExpression) {
      await queryInterface.sequelize.query(`
        ALTER TABLE toilet_qr_codes
        ALTER COLUMN id SET DEFAULT ${uuidFunctionExpression};
      `);
    }

    await addIndexSafe(
      queryInterface,
      'toilet_qr_codes',
      ['toilet_unit_id', 'status'],
      'toilet_qr_codes_toilet_status_idx'
    );
    await addIndexSafe(
      queryInterface,
      'toilet_qr_codes',
      ['tenant_id', 'status'],
      'toilet_qr_codes_tenant_status_idx'
    );

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS toilet_qr_codes_normalized_code_uk
      ON toilet_qr_codes (UPPER(TRIM(qr_code)));
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS toilet_qr_codes_primary_per_toilet_uk
      ON toilet_qr_codes (toilet_unit_id)
      WHERE is_primary = true AND status = 'active';
    `);

    const primaryQrInsertIdExpression = resolveInsertUuidExpression(
      uuidFunctionExpression,
      `tu.id::text || ':legacy_v1:' || UPPER(TRIM(tu.qr_code))`
    );

    await queryInterface.sequelize.query(`
      INSERT INTO toilet_qr_codes (
        id,
        tenant_id,
        toilet_unit_id,
        qr_code,
        schema_version,
        qr_payload,
        status,
        is_primary,
        created_at,
        updated_at
      )
      SELECT
        ${primaryQrInsertIdExpression},
        f.tenant_id,
        tu.id,
        UPPER(TRIM(tu.qr_code)),
        'legacy_v1',
        jsonb_build_object(
          'source', 'toilet_units.qr_code',
          'legacy', true,
          'toiletUnitId', tu.id
        ),
        'active',
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM toilet_units tu
      JOIN facilities f ON f.id = tu.facility_id
      WHERE tu.qr_code IS NOT NULL
        AND BTRIM(tu.qr_code) <> ''
      ON CONFLICT DO NOTHING;
    `);

    const aliasQrInsertIdExpression = resolveInsertUuidExpression(
      uuidFunctionExpression,
      `tu.id::text || ':legacy_code_alias:' || UPPER(TRIM(tu.code))`
    );

    await queryInterface.sequelize.query(`
      INSERT INTO toilet_qr_codes (
        id,
        tenant_id,
        toilet_unit_id,
        qr_code,
        schema_version,
        qr_payload,
        status,
        is_primary,
        created_at,
        updated_at
      )
      SELECT
        ${aliasQrInsertIdExpression},
        f.tenant_id,
        tu.id,
        UPPER(TRIM(tu.code)),
        'legacy_code_alias',
        jsonb_build_object(
          'source', 'toilet_units.code',
          'legacy', true,
          'toiletUnitId', tu.id
        ),
        'active',
        false,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM toilet_units tu
      JOIN facilities f ON f.id = tu.facility_id
      WHERE tu.code IS NOT NULL
        AND BTRIM(tu.code) <> ''
      ON CONFLICT DO NOTHING;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS toilet_qr_codes_primary_per_toilet_uk;
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS toilet_qr_codes_normalized_code_uk;
    `);

    await removeIndexSafe(queryInterface, 'toilet_qr_codes', 'toilet_qr_codes_tenant_status_idx');
    await removeIndexSafe(queryInterface, 'toilet_qr_codes', 'toilet_qr_codes_toilet_status_idx');
    await queryInterface.dropTable('toilet_qr_codes');

    await removeIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      'ai_processing_jobs_status_next_retry_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      'ai_processing_jobs_status_lease_idx'
    );
    await removeColumnIfExists(queryInterface, 'ai_processing_jobs', 'next_retry_at');
    await removeColumnIfExists(queryInterface, 'ai_processing_jobs', 'dead_letter_reason');
    await removeColumnIfExists(
      queryInterface,
      'ai_processing_jobs',
      'failure_classification'
    );
    await removeColumnIfExists(queryInterface, 'ai_processing_jobs', 'last_heartbeat_at');
    await removeColumnIfExists(queryInterface, 'ai_processing_jobs', 'leased_until');

    await removeIndexSafe(
      queryInterface,
      'image_sessions',
      'image_sessions_status_upload_expiry_idx'
    );
    await removeColumnIfExists(queryInterface, 'image_sessions', 'object_key_locked');
    await removeColumnIfExists(queryInterface, 'image_sessions', 'last_reconcile_error');
    await removeColumnIfExists(queryInterface, 'image_sessions', 'reconciled_at');
    await removeColumnIfExists(queryInterface, 'image_sessions', 'reconcile_attempts');

    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_worker_state_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_state_next_retry_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_processing_state_idx'
    );

    await removeColumnIfExists(queryInterface, 'inspection_media', 'storage_verified_at');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'manual_review_required_at');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'last_error_message');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'last_error_code');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'next_retry_at');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'last_retry_at');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'ai_attempt_count');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'retry_count');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'processing_state');
    await removeColumnIfExists(queryInterface, 'inspections', 'pipeline_counters');
  },
};
