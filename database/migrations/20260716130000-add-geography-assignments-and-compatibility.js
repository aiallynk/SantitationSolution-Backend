'use strict';

const { randomUUID } = require('crypto');

module.exports = {
  async up(queryInterface, Sequelize) {
    const geographyColumns = await queryInterface.describeTable('geographies');
    if (!geographyColumns.master_geography_id) await queryInterface.addColumn('geographies', 'master_geography_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'geographies', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    if (!geographyColumns.administrative_type) await queryInterface.addColumn('geographies', 'administrative_type', {
      type: Sequelize.STRING(80),
      allowNull: true,
    });
    if (!geographyColumns.source_administrative_level) await queryInterface.addColumn('geographies', 'source_administrative_level', {
      type: Sequelize.STRING(80),
      allowNull: true,
    });

    const existingTables = new Set((await queryInterface.showAllTables()).map((table) =>
      String(typeof table === 'string' ? table : table.tableName || table.table_name || '').toLowerCase()
    ));
    if (!existingTables.has('tenant_geography_assignments')) await queryInterface.createTable('tenant_geography_assignments', {
      id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      geography_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'geographies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      is_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    const assignmentIndexes = new Set((await queryInterface.showIndex('tenant_geography_assignments')).map((index) => index.name));
    if (!assignmentIndexes.has('tenant_geography_assignments_tenant_geography_uq')) await queryInterface.addIndex('tenant_geography_assignments', ['tenant_id', 'geography_id'], {
      unique: true,
      name: 'tenant_geography_assignments_tenant_geography_uq',
    });
    if (!assignmentIndexes.has('tenant_geography_assignments_enabled_idx')) await queryInterface.addIndex('tenant_geography_assignments', ['tenant_id', 'is_enabled'], {
      name: 'tenant_geography_assignments_enabled_idx',
    });

    if (!existingTables.has('geography_external_identifiers')) await queryInterface.createTable('geography_external_identifiers', {
      id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
      geography_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'geographies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      external_source: { type: Sequelize.STRING(80), allowNull: false },
      external_code: { type: Sequelize.STRING(160), allowNull: false },
      is_primary: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    const identifierIndexes = new Set((await queryInterface.showIndex('geography_external_identifiers')).map((index) => index.name));
    if (!identifierIndexes.has('geography_external_identifiers_source_code_uq')) await queryInterface.addIndex('geography_external_identifiers', ['external_source', 'external_code'], {
      unique: true,
      name: 'geography_external_identifiers_source_code_uq',
    });
    if (!identifierIndexes.has('geography_external_identifiers_geography_idx')) await queryInterface.addIndex('geography_external_identifiers', ['geography_id'], {
      name: 'geography_external_identifiers_geography_idx',
    });
    const [externalRows] = await queryInterface.sequelize.query(`
      SELECT id, external_source, external_code
      FROM geographies
      WHERE external_source IS NOT NULL AND external_code IS NOT NULL
    `);
    if (externalRows.length > 0) {
      const now = new Date();
      await queryInterface.bulkInsert('geography_external_identifiers', externalRows.map((row) => ({
        id: randomUUID(),
        geography_id: row.id,
        external_source: row.external_source,
        external_code: row.external_code,
        is_primary: true,
        created_at: now,
        updated_at: now,
      })), { ignoreDuplicates: true });
    }

    if (!existingTables.has('geography_migration_reviews')) await queryInterface.createTable('geography_migration_reviews', {
      id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      legacy_geography_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'geographies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      candidate_master_geography_ids: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: Sequelize.literal("'[]'::jsonb"),
      },
      match_method: { type: Sequelize.STRING(40), allowNull: true },
      status: {
        type: Sequelize.ENUM('pending', 'matched', 'ignored'),
        allowNull: false,
        defaultValue: 'pending',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      reviewed_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      reviewed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    const reviewIndexes = new Set((await queryInterface.showIndex('geography_migration_reviews')).map((index) => index.name));
    if (!reviewIndexes.has('geography_migration_reviews_legacy_uq')) await queryInterface.addIndex('geography_migration_reviews', ['legacy_geography_id'], {
      unique: true,
      name: 'geography_migration_reviews_legacy_uq',
    });
    if (!reviewIndexes.has('geography_migration_reviews_tenant_status_idx')) await queryInterface.addIndex('geography_migration_reviews', ['tenant_id', 'status'], {
      name: 'geography_migration_reviews_tenant_status_idx',
    });

    const geographyIndexes = new Set((await queryInterface.showIndex('geographies')).map((index) => index.name));
    if (!geographyIndexes.has('geographies_master_geography_idx')) await queryInterface.addIndex('geographies', ['master_geography_id'], {
      name: 'geographies_master_geography_idx',
    });
    if (!geographyIndexes.has('geographies_level_parent_active_name_idx')) await queryInterface.addIndex('geographies', ['level', 'parent_id', 'is_active', 'normalized_name'], {
      name: 'geographies_level_parent_active_name_idx',
    });
    if (!geographyIndexes.has('geographies_external_source_code_lookup_idx')) await queryInterface.addIndex('geographies', ['external_source', 'external_code'], {
      name: 'geographies_external_source_code_lookup_idx',
    });

    // Existing tenant-owned official rows stay in place; unambiguous canonical matches are linked.
    const [legacyRows] = await queryInterface.sequelize.query(`
      SELECT legacy.id, legacy.tenant_id, legacy.level, legacy.normalized_name,
             legacy.parent_id, legacy.place_id, legacy.map_place_id, legacy.external_place_id
      FROM geographies legacy
      WHERE legacy.tenant_id IS NOT NULL
        AND legacy.level IN ('country', 'state', 'district', 'city')
        AND legacy.master_geography_id IS NULL
    `);
    for (const legacy of legacyRows) {
      const placeId = legacy.external_place_id || legacy.map_place_id || legacy.place_id || null;
      const replacements = {
        level: legacy.level,
        normalizedName: legacy.normalized_name,
        placeId,
      };
      const [candidates] = await queryInterface.sequelize.query(`
        SELECT id
        FROM geographies
        WHERE tenant_id IS NULL
          AND level = :level
          AND is_active = TRUE
          AND (
            (:placeId IS NOT NULL AND :placeId IN (external_place_id, map_place_id, place_id))
            OR (:normalizedName IS NOT NULL AND normalized_name = :normalizedName)
          )
        ORDER BY CASE WHEN :placeId IS NOT NULL AND :placeId IN (external_place_id, map_place_id, place_id) THEN 0 ELSE 1 END,
                 id
      `, { replacements });
      if (candidates.length === 1) {
        await queryInterface.sequelize.query(`
          UPDATE geographies SET master_geography_id = :masterId, updated_at = CURRENT_TIMESTAMP WHERE id = :legacyId
        `, { replacements: { masterId: candidates[0].id, legacyId: legacy.id } });
        await queryInterface.bulkInsert('tenant_geography_assignments', [{
          id: randomUUID(),
          tenant_id: legacy.tenant_id,
          geography_id: candidates[0].id,
          is_enabled: true,
          created_by_user_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        }], { ignoreDuplicates: true });
      } else {
        await queryInterface.bulkInsert('geography_migration_reviews', [{
          id: randomUUID(),
          tenant_id: legacy.tenant_id,
          legacy_geography_id: legacy.id,
          candidate_master_geography_ids: JSON.stringify(candidates.map((candidate) => candidate.id)),
          match_method: placeId ? 'place_id_or_normalized_name' : 'normalized_name',
          status: 'pending',
          notes: candidates.length === 0 ? 'No canonical match found' : 'Ambiguous canonical match',
          reviewed_by_user_id: null,
          reviewed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }], { ignoreDuplicates: true });
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('geographies', 'geographies_external_source_code_lookup_idx');
    await queryInterface.removeIndex('geographies', 'geographies_level_parent_active_name_idx');
    await queryInterface.removeIndex('geographies', 'geographies_master_geography_idx');
    await queryInterface.dropTable('geography_migration_reviews');
    await queryInterface.dropTable('geography_external_identifiers');
    await queryInterface.dropTable('tenant_geography_assignments');
    await queryInterface.removeColumn('geographies', 'source_administrative_level');
    await queryInterface.removeColumn('geographies', 'administrative_type');
    await queryInterface.removeColumn('geographies', 'master_geography_id');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_geography_migration_reviews_status";');
  },
};
