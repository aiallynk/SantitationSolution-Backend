'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('geographies', 'tenant_id', {
      type: Sequelize.UUID,
      allowNull: true,
    });

    const geographyColumns = await queryInterface.describeTable('geographies');
    const columns = {
      normalized_name: { type: Sequelize.STRING(220), allowNull: true },
      external_source: { type: Sequelize.STRING(80), allowNull: true },
      external_code: { type: Sequelize.STRING(160), allowNull: true },
      external_place_id: { type: Sequelize.STRING(220), allowNull: true },
      country_code: { type: Sequelize.STRING(10), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      is_official_source: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_platform_managed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_verified_local_government: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    };
    for (const [columnName, definition] of Object.entries(columns)) {
      if (!geographyColumns[columnName]) {
        await queryInterface.addColumn('geographies', columnName, definition);
      }
    }

    await queryInterface.sequelize.query(`
      UPDATE geographies
      SET
        normalized_name = LOWER(TRIM(name)),
        country_code = COALESCE(
          country_code,
          CASE
            WHEN level = 'country' AND LENGTH(TRIM(code)) <= 10 THEN UPPER(NULLIF(TRIM(code), ''))
            ELSE NULL
          END
        ),
        is_active = TRUE,
        is_official_source = FALSE,
        is_platform_managed = CASE WHEN level IN ('country','state','district','city') THEN TRUE ELSE FALSE END,
        is_verified_local_government = FALSE
      WHERE normalized_name IS NULL
         OR is_active IS NULL
         OR is_official_source IS NULL
         OR is_platform_managed IS NULL
         OR is_verified_local_government IS NULL
         OR country_code IS NULL;
    `);

    const geographyIndexNames = new Set((await queryInterface.showIndex('geographies')).map((index) => index.name));
    if (!geographyIndexNames.has('geographies_external_source_code_uk')) {
      await queryInterface.addIndex('geographies', ['external_source', 'external_code'], {
        unique: true,
        where: {
          external_source: { [Sequelize.Op.ne]: null },
          external_code: { [Sequelize.Op.ne]: null },
        },
        name: 'geographies_external_source_code_uk',
      });
    }
    if (!geographyIndexNames.has('geographies_tenant_parent_level_active_idx')) {
      await queryInterface.addIndex('geographies', ['tenant_id', 'parent_id', 'level', 'is_active'], {
        name: 'geographies_tenant_parent_level_active_idx',
      });
    }
    if (!geographyIndexNames.has('geographies_country_level_active_idx')) {
      await queryInterface.addIndex('geographies', ['country_code', 'level', 'is_active'], {
        name: 'geographies_country_level_active_idx',
      });
    }

    const existingTables = (await queryInterface.showAllTables()).map((table) =>
      String(typeof table === 'string' ? table : table.tableName || table.table_name || '').toLowerCase()
    );
    if (!existingTables.includes('geography_import_jobs')) {
      await queryInterface.createTable('geography_import_jobs', {
      id: {
        type: Sequelize.UUID,
        allowNull: false,
        primaryKey: true,
      },
      source: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      country_code: {
        type: Sequelize.STRING(10),
        allowNull: true,
      },
      level: {
        type: Sequelize.STRING(20),
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('queued', 'running', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      requested_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      idempotency_key: {
        type: Sequelize.STRING(160),
        allowNull: false,
      },
      input_hash: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      summary: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      payload: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      started_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      });
    }

    const importIndexNames = new Set((await queryInterface.showIndex('geography_import_jobs')).map((index) => index.name));
    if (!importIndexNames.has('geography_import_jobs_idempotency_uk')) {
      await queryInterface.addIndex('geography_import_jobs', ['idempotency_key'], {
        unique: true,
        name: 'geography_import_jobs_idempotency_uk',
      });
    }
    if (!importIndexNames.has('geography_import_jobs_source_country_level_status_idx')) {
      await queryInterface.addIndex('geography_import_jobs', ['source', 'country_code', 'level', 'status'], {
        name: 'geography_import_jobs_source_country_level_status_idx',
      });
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('geography_import_jobs', 'geography_import_jobs_source_country_level_status_idx');
    await queryInterface.removeIndex('geography_import_jobs', 'geography_import_jobs_idempotency_uk');
    await queryInterface.dropTable('geography_import_jobs');

    await queryInterface.removeIndex('geographies', 'geographies_country_level_active_idx');
    await queryInterface.removeIndex('geographies', 'geographies_tenant_parent_level_active_idx');
    await queryInterface.removeIndex('geographies', 'geographies_external_source_code_uk');

    await queryInterface.removeColumn('geographies', 'is_verified_local_government');
    await queryInterface.removeColumn('geographies', 'is_platform_managed');
    await queryInterface.removeColumn('geographies', 'is_official_source');
    await queryInterface.removeColumn('geographies', 'is_active');
    await queryInterface.removeColumn('geographies', 'country_code');
    await queryInterface.removeColumn('geographies', 'external_place_id');
    await queryInterface.removeColumn('geographies', 'external_code');
    await queryInterface.removeColumn('geographies', 'external_source');
    await queryInterface.removeColumn('geographies', 'normalized_name');

    await queryInterface.changeColumn('geographies', 'tenant_id', {
      type: Sequelize.UUID,
      allowNull: false,
    });
  },
};
