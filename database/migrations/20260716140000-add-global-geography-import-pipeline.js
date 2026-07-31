'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('geographies');
    const additions = {
      global_geography_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'geographies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      ascii_name: { type: Sequelize.STRING(220), allowNull: true },
      local_name: { type: Sequelize.STRING(220), allowNull: true },
      alternate_names: { type: Sequelize.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      country_iso2: { type: Sequelize.STRING(2), allowNull: true },
      country_iso3: { type: Sequelize.STRING(3), allowNull: true },
      admin1_code: { type: Sequelize.STRING(40), allowNull: true },
      admin2_code: { type: Sequelize.STRING(40), allowNull: true },
      admin3_code: { type: Sequelize.STRING(40), allowNull: true },
      admin4_code: { type: Sequelize.STRING(40), allowNull: true },
      simplified_geojson: { type: Sequelize.JSONB, allowNull: true },
      population: { type: Sequelize.BIGINT, allowNull: true },
      timezone: { type: Sequelize.STRING(80), allowNull: true },
      preferred_source: { type: Sequelize.STRING(40), allowNull: true },
      preferred_external_code: { type: Sequelize.STRING(160), allowNull: true },
      source_modified_at: { type: Sequelize.DATEONLY, allowNull: true },
      quality_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'imported' },
      import_batch_id: { type: Sequelize.UUID, allowNull: true },
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns[name]) await queryInterface.addColumn('geographies', name, definition);
    }

    await queryInterface.sequelize.query(`
      UPDATE geographies
      SET global_geography_id = master_geography_id
      WHERE global_geography_id IS NULL AND master_geography_id IS NOT NULL;
      UPDATE geographies
      SET country_iso2 = CASE WHEN LENGTH(country_code) = 2 THEN UPPER(country_code) ELSE country_iso2 END,
          preferred_source = COALESCE(preferred_source, external_source),
          preferred_external_code = COALESCE(preferred_external_code, external_code)
      WHERE tenant_id IS NULL;
    `);

    const existingTables = new Set((await queryInterface.showAllTables()).map((table) =>
      String(typeof table === 'string' ? table : table.tableName || table.table_name || '').toLowerCase()
    ));

    if (!existingTables.has('global_geography_import_batches')) {
      await queryInterface.createTable('global_geography_import_batches', {
        id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
        source: { type: Sequelize.STRING(40), allowNull: false },
        input_scope: { type: Sequelize.STRING(120), allowNull: false, defaultValue: 'all' },
        source_version: { type: Sequelize.STRING(120), allowNull: true },
        source_file: { type: Sequelize.STRING(500), allowNull: true },
        checksum: { type: Sequelize.STRING(128), allowNull: true },
        checkpoint: { type: Sequelize.JSONB, allowNull: true },
        started_at: { type: Sequelize.DATE, allowNull: true },
        completed_at: { type: Sequelize.DATE, allowNull: true },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'queued' },
        total_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        inserted_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        updated_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        unchanged_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        skipped_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        failed_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        ambiguous_records: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        error_summary: { type: Sequelize.JSONB, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    if (!existingTables.has('global_geography_sources')) {
      await queryInterface.createTable('global_geography_sources', {
        id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
        global_geography_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'geographies', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        source: { type: Sequelize.STRING(40), allowNull: false },
        external_code: { type: Sequelize.STRING(160), allowNull: false },
        source_name: { type: Sequelize.STRING(220), allowNull: true },
        source_level: { type: Sequelize.STRING(80), allowNull: true },
        source_parent_code: { type: Sequelize.STRING(160), allowNull: true },
        source_latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        source_longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        source_payload: { type: Sequelize.JSONB, allowNull: true },
        boundary_id: { type: Sequelize.STRING(180), allowNull: true },
        source_licence: { type: Sequelize.STRING(220), allowNull: true },
        source_attribution: { type: Sequelize.TEXT, allowNull: true },
        source_reference: { type: Sequelize.STRING(1000), allowNull: true },
        source_modified_at: { type: Sequelize.DATEONLY, allowNull: true },
        is_preferred: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    if (!existingTables.has('global_geography_aliases')) {
      await queryInterface.createTable('global_geography_aliases', {
        id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
        global_geography_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'geographies', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        name: { type: Sequelize.STRING(300), allowNull: false },
        normalized_name: { type: Sequelize.STRING(320), allowNull: false },
        language_code: { type: Sequelize.STRING(20), allowNull: true },
        is_preferred: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_short_name: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_historic: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        source: { type: Sequelize.STRING(40), allowNull: false },
        external_code: { type: Sequelize.STRING(160), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    if (!existingTables.has('global_geography_import_staging')) {
      await queryInterface.createTable('global_geography_import_staging', {
        id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
        import_batch_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'global_geography_import_batches', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        source: { type: Sequelize.STRING(40), allowNull: false },
        external_code: { type: Sequelize.STRING(160), allowNull: false },
        parent_external_code: { type: Sequelize.STRING(160), allowNull: true },
        raw_name: { type: Sequelize.STRING(300), allowNull: true },
        normalized_name: { type: Sequelize.STRING(320), allowNull: true },
        raw_level: { type: Sequelize.STRING(80), allowNull: true },
        normalized_level: { type: Sequelize.STRING(20), allowNull: true },
        country_iso2: { type: Sequelize.STRING(2), allowNull: true },
        country_iso3: { type: Sequelize.STRING(3), allowNull: true },
        admin1_code: { type: Sequelize.STRING(40), allowNull: true },
        admin2_code: { type: Sequelize.STRING(40), allowNull: true },
        admin3_code: { type: Sequelize.STRING(40), allowNull: true },
        admin4_code: { type: Sequelize.STRING(40), allowNull: true },
        latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        raw_payload: { type: Sequelize.JSONB, allowNull: true },
        validation_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
        validation_error: { type: Sequelize.TEXT, allowNull: true },
        processed_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    const addIndex = async (table, fields, options) => {
      const indexes = new Set((await queryInterface.showIndex(table)).map((index) => index.name));
      if (!indexes.has(options.name)) await queryInterface.addIndex(table, fields, options);
    };
    await addIndex('geographies', ['global_geography_id'], { name: 'geographies_global_geography_idx' });
    await addIndex('geographies', ['tenant_id', 'global_geography_id'], {
      name: 'geographies_tenant_global_uq',
      unique: true,
      where: { tenant_id: { [Sequelize.Op.ne]: null }, global_geography_id: { [Sequelize.Op.ne]: null } },
    });
    await addIndex('geographies', ['country_iso2', 'level', 'is_active'], { name: 'geographies_iso2_level_active_idx' });
    await addIndex('geographies', ['country_iso3', 'level', 'is_active'], { name: 'geographies_iso3_level_active_idx' });
    await addIndex('geographies', ['preferred_external_code'], { name: 'geographies_preferred_external_code_idx' });
    await addIndex('geographies', ['admin1_code', 'admin2_code'], { name: 'geographies_admin_codes_idx' });
    await addIndex('global_geography_sources', ['source', 'external_code'], { name: 'global_geography_sources_identity_uq', unique: true });
    await addIndex('global_geography_sources', ['global_geography_id'], { name: 'global_geography_sources_geography_idx' });
    await addIndex('global_geography_aliases', ['normalized_name'], { name: 'global_geography_aliases_normalized_idx' });
    await addIndex('global_geography_aliases', ['global_geography_id', 'source', 'normalized_name'], { name: 'global_geography_aliases_identity_uq', unique: true });
    await addIndex('global_geography_import_batches', ['source', 'checksum', 'input_scope'], { name: 'global_geography_batches_source_checksum_uq', unique: true });
    await addIndex('global_geography_import_batches', ['status', 'created_at'], { name: 'global_geography_batches_status_idx' });
    await addIndex('global_geography_import_staging', ['import_batch_id', 'source', 'external_code'], { name: 'global_geography_staging_identity_uq', unique: true });
    await addIndex('global_geography_import_staging', ['import_batch_id', 'validation_status'], { name: 'global_geography_staging_status_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('global_geography_import_staging');
    await queryInterface.dropTable('global_geography_aliases');
    await queryInterface.dropTable('global_geography_sources');
    await queryInterface.dropTable('global_geography_import_batches');
    for (const column of [
      'import_batch_id', 'quality_status', 'source_modified_at', 'preferred_external_code',
      'preferred_source', 'timezone', 'population', 'simplified_geojson', 'admin4_code',
      'admin3_code', 'admin2_code', 'admin1_code', 'country_iso3', 'country_iso2',
      'alternate_names', 'local_name', 'ascii_name', 'global_geography_id',
    ]) {
      await queryInterface.removeColumn('geographies', column);
    }
  },
};
