'use strict';

/**
 * Production repair migration.
 *
 * Some deployed databases can have `sequelize_meta` marked past the hierarchy
 * refactor while still missing one or more columns, which makes normal
 * `db:migrate` report "up to date" but runtime SELECTs fail with 42703
 * (`SCHEMA_MISMATCH`). Keep this migration idempotent so it safely heals both
 * fresh and partially-migrated databases.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        enum_type_name text;
        assignment_level text;
      BEGIN
        SELECT t.typname
        INTO enum_type_name
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('enum_worker_assignments_assignment_level', 'worker_assignments_assignment_level_enum')
        LIMIT 1;

        IF enum_type_name IS NOT NULL THEN
          FOREACH assignment_level IN ARRAY ARRAY['country', 'state', 'district', 'city', 'zone', 'ward']
          LOOP
            EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_type_name, assignment_level);
          END LOOP;
        END IF;
      END $$;

      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_name VARCHAR(180);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_email VARCHAR(180);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_mobile VARCHAR(32);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS scope_level VARCHAR(20) NOT NULL DEFAULT 'city';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS country_name VARCHAR(120);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS state_name VARCHAR(120);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS district_name VARCHAR(120);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS city_name VARCHAR(120);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS zone_name VARCHAR(120);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_line VARCHAR(300);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS root_geography_id UUID REFERENCES geographies(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS tenants_scope_level_idx ON tenants(scope_level);
      CREATE INDEX IF NOT EXISTS tenants_root_geography_idx ON tenants(root_geography_id);

      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS user_id_code VARCHAR(40);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS remarks VARCHAR(500);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS country_name VARCHAR(120);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS state_name VARCHAR(120);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS district_name VARCHAR(120);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS city_name VARCHAR(120);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS zone_name VARCHAR(120);
      ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS ward_name VARCHAR(120);

      CREATE UNIQUE INDEX IF NOT EXISTS platform_users_user_id_code_uk
        ON platform_users(user_id_code)
        WHERE user_id_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS platform_users_tenant_phone_idx ON platform_users(tenant_id, phone);

      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS geometry_type VARCHAR(20);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS geojson JSONB;
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS boundary_center_latitude NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS boundary_center_longitude NUMERIC(10,7);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS boundary_radius_meters NUMERIC(12,2);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS bounds JSONB;
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS area_sq_km NUMERIC(14,4);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS boundary_label VARCHAR(220);
      ALTER TABLE geographies ADD COLUMN IF NOT EXISTS is_operational_zone BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE INDEX IF NOT EXISTS geographies_tenant_parent_level_idx
        ON geographies(tenant_id, parent_id, level);
      CREATE INDEX IF NOT EXISTS geographies_tenant_operational_idx
        ON geographies(tenant_id, is_operational_zone);

      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS zone_geography_id UUID REFERENCES geographies(id) ON DELETE SET NULL;
      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS ward_geography_id UUID REFERENCES geographies(id) ON DELETE SET NULL;
      ALTER TABLE facilities ADD COLUMN IF NOT EXISTS supervisor_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS facilities_tenant_zone_idx ON facilities(tenant_id, zone_geography_id);
      CREATE INDEX IF NOT EXISTS facilities_tenant_ward_idx ON facilities(tenant_id, ward_geography_id);
      CREATE INDEX IF NOT EXISTS facilities_tenant_supervisor_idx ON facilities(tenant_id, supervisor_user_id);

      ALTER TABLE worker_assignments ADD COLUMN IF NOT EXISTS supervisor_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS worker_assignments_tenant_supervisor_status_idx
        ON worker_assignments(tenant_id, supervisor_user_id, status);
    `);
  },

  async down() {
    // Intentionally no-op. This is a schema-drift repair migration and should
    // not remove columns that may already be used by production code/data.
  },
};
