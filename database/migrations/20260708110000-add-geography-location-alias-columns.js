'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS place_id VARCHAR(220);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS formatted_address VARCHAR(500);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS bounds_north NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS bounds_south NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS bounds_east NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS bounds_west NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS scope_type VARCHAR(40);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS scope_name VARCHAR(200);

      UPDATE geographies
      SET
        latitude = COALESCE(latitude, centroid_latitude),
        longitude = COALESCE(longitude, centroid_longitude),
        place_id = COALESCE(place_id, map_place_id),
        formatted_address = COALESCE(formatted_address, map_display_address),
        bounds_north = COALESCE(bounds_north, (bounds->>'north')::numeric),
        bounds_south = COALESCE(bounds_south, (bounds->>'south')::numeric),
        bounds_east = COALESCE(bounds_east, (bounds->>'east')::numeric),
        bounds_west = COALESCE(bounds_west, (bounds->>'west')::numeric),
        scope_type = COALESCE(scope_type, level::text),
        scope_name = COALESCE(scope_name, name)
      WHERE bounds IS NULL OR jsonb_typeof(bounds) = 'object';

      CREATE INDEX IF NOT EXISTS geographies_tenant_place_id_idx
        ON geographies(tenant_id, place_id)
        WHERE place_id IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS geographies_tenant_place_id_idx;
      ALTER TABLE geographies DROP COLUMN IF EXISTS scope_name;
      ALTER TABLE geographies DROP COLUMN IF EXISTS scope_type;
      ALTER TABLE geographies DROP COLUMN IF EXISTS bounds_west;
      ALTER TABLE geographies DROP COLUMN IF EXISTS bounds_east;
      ALTER TABLE geographies DROP COLUMN IF EXISTS bounds_south;
      ALTER TABLE geographies DROP COLUMN IF EXISTS bounds_north;
      ALTER TABLE geographies DROP COLUMN IF EXISTS formatted_address;
      ALTER TABLE geographies DROP COLUMN IF EXISTS place_id;
      ALTER TABLE geographies DROP COLUMN IF EXISTS longitude;
      ALTER TABLE geographies DROP COLUMN IF EXISTS latitude;
    `);
  },
};
