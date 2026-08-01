'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS map_display_address VARCHAR(500);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS map_place_id VARCHAR(220);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS map_source VARCHAR(80);

      CREATE INDEX IF NOT EXISTS geographies_tenant_map_place_idx
        ON geographies(tenant_id, map_place_id)
        WHERE map_place_id IS NOT NULL;

      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS map_display_address VARCHAR(500);
      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS map_place_id VARCHAR(220);
      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS map_source VARCHAR(80);

      CREATE INDEX IF NOT EXISTS facilities_tenant_map_place_idx
        ON facilities(tenant_id, map_place_id)
        WHERE map_place_id IS NOT NULL;

      ALTER TABLE toilet_units ADD COLUMN IF NOT EXISTS map_display_address VARCHAR(500);
      ALTER TABLE toilet_units ADD COLUMN IF NOT EXISTS map_place_id VARCHAR(220);
      ALTER TABLE toilet_units ADD COLUMN IF NOT EXISTS map_source VARCHAR(80);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS facilities_tenant_map_place_idx;
      DROP INDEX IF EXISTS geographies_tenant_map_place_idx;
      ALTER TABLE toilet_units DROP COLUMN IF EXISTS map_source;
      ALTER TABLE toilet_units DROP COLUMN IF EXISTS map_place_id;
      ALTER TABLE toilet_units DROP COLUMN IF EXISTS map_display_address;
      ALTER TABLE facilities DROP COLUMN IF EXISTS map_source;
      ALTER TABLE facilities DROP COLUMN IF EXISTS map_place_id;
      ALTER TABLE facilities DROP COLUMN IF EXISTS map_display_address;
      ALTER TABLE geographies DROP COLUMN IF EXISTS map_source;
      ALTER TABLE geographies DROP COLUMN IF EXISTS map_place_id;
      ALTER TABLE geographies DROP COLUMN IF EXISTS map_display_address;
    `);
  },
};
