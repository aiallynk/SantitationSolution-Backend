-- 20260413_003_admin_hierarchy_refactor.sql
-- Backward-compatible hierarchy refactor for tenant profile, user geography context,
-- operational geography geometry, facility chain mapping, and supervisor linkage.

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
CREATE INDEX IF NOT EXISTS platform_users_tenant_phone_idx
  ON platform_users(tenant_id, phone);

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
CREATE INDEX IF NOT EXISTS facilities_tenant_zone_idx
  ON facilities(tenant_id, zone_geography_id);
CREATE INDEX IF NOT EXISTS facilities_tenant_ward_idx
  ON facilities(tenant_id, ward_geography_id);
CREATE INDEX IF NOT EXISTS facilities_tenant_supervisor_idx
  ON facilities(tenant_id, supervisor_user_id);

ALTER TABLE worker_assignments ADD COLUMN IF NOT EXISTS supervisor_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS worker_assignments_tenant_supervisor_status_idx
  ON worker_assignments(tenant_id, supervisor_user_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_worker_assignments_assignment_level') THEN
    ALTER TYPE enum_worker_assignments_assignment_level ADD VALUE IF NOT EXISTS 'country';
    ALTER TYPE enum_worker_assignments_assignment_level ADD VALUE IF NOT EXISTS 'state';
    ALTER TYPE enum_worker_assignments_assignment_level ADD VALUE IF NOT EXISTS 'district';
    ALTER TYPE enum_worker_assignments_assignment_level ADD VALUE IF NOT EXISTS 'city';
    ALTER TYPE enum_worker_assignments_assignment_level ADD VALUE IF NOT EXISTS 'zone';
    ALTER TYPE enum_worker_assignments_assignment_level ADD VALUE IF NOT EXISTS 'ward';
  ELSIF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'worker_assignments_assignment_level_enum') THEN
    ALTER TYPE worker_assignments_assignment_level_enum ADD VALUE IF NOT EXISTS 'country';
    ALTER TYPE worker_assignments_assignment_level_enum ADD VALUE IF NOT EXISTS 'state';
    ALTER TYPE worker_assignments_assignment_level_enum ADD VALUE IF NOT EXISTS 'district';
    ALTER TYPE worker_assignments_assignment_level_enum ADD VALUE IF NOT EXISTS 'city';
    ALTER TYPE worker_assignments_assignment_level_enum ADD VALUE IF NOT EXISTS 'zone';
    ALTER TYPE worker_assignments_assignment_level_enum ADD VALUE IF NOT EXISTS 'ward';
  END IF;
END $$;
