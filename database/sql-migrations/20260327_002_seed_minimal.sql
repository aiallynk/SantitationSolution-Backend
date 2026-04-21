-- 20260327_002_seed_minimal.sql
-- Minimal non-mock seed: 1 super admin, 1 tenant, sample facility and tasks.

INSERT INTO tenants (id, name, code, status, country_code, metadata)
VALUES (
  'b1111111-1111-4111-8111-111111111111',
  'Supabase Demo Tenant',
  'SUPA-DEMO',
  'active',
  'IN',
  '{"source":"minimal-seed"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO geographies (id, tenant_id, parent_id, level, code, name, centroid_latitude, centroid_longitude)
VALUES (
  'b2222222-2222-4222-8222-222222222222',
  'b1111111-1111-4111-8111-111111111111',
  NULL,
  'city',
  'CITY-01',
  'Demo City',
  19.076,
  72.8777
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO facilities (id, tenant_id, geography_id, code, name, facility_type, address_line, latitude, longitude, status, metadata)
VALUES (
  'b3333333-3333-4333-8333-333333333333',
  'b1111111-1111-4111-8111-111111111111',
  'b2222222-2222-4222-8222-222222222222',
  'FAC-001',
  'Central Bus Stand Toilet Complex',
  'toilet_complex',
  'Central Bus Stand',
  19.076,
  72.8777,
  'active',
  '{"source":"minimal-seed"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO toilet_blocks (id, facility_id, code, name, gender_type, status)
VALUES (
  'b4444444-4444-4444-8444-444444444444',
  'b3333333-3333-4333-8333-333333333333',
  'BLK-A',
  'Main Block A',
  'general',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO toilet_units (id, facility_id, toilet_block_id, code, unit_type, status)
VALUES (
  'b5555555-5555-4555-8555-555555555555',
  'b3333333-3333-4333-8333-333333333333',
  'b4444444-4444-4444-8444-444444444444',
  'UNIT-01',
  'general',
  'moderate'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, code, name, description)
VALUES (
  'b6666666-6666-4666-8666-666666666666',
  'super_admin',
  'Super Admin',
  'Platform owner role'
)
ON CONFLICT (id) DO NOTHING;

-- bcrypt hash for 11111111 generated in seeder script path.
INSERT INTO platform_users (id, tenant_id, geography_id, full_name, email, phone, password_hash, auth_provider, status)
VALUES (
  'b7777777-7777-4777-8777-777777777777',
  NULL,
  NULL,
  'Platform Super Admin',
  'superadmin@platform.gov',
  '9000001111',
  '$2b$10$6/1tChha1CAMRNK.OUCOSuvEiGIPyXqQU4jaX1qbfAjiduT9d2QyG',
  'local',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_roles (id, user_id, role_id, tenant_id, geography_id)
VALUES (
  'b8888888-8888-4888-8888-888888888888',
  'b7777777-7777-4777-8777-777777777777',
  'b6666666-6666-4666-8666-666666666666',
  NULL,
  NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inspection_tasks (id, tenant_id, facility_id, toilet_unit_id, assigned_to_user_id, task_type, scheduled_at, sla_minutes, status)
VALUES
(
  'b9999999-9999-4999-8999-999999999991',
  'b1111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'b5555555-5555-4555-8555-555555555555',
  'b7777777-7777-4777-8777-777777777777',
  'routine_cleaning',
  NOW(),
  45,
  'pending'
),
(
  'b9999999-9999-4999-8999-999999999992',
  'b1111111-1111-4111-8111-111111111111',
  'b3333333-3333-4333-8333-333333333333',
  'b5555555-5555-4555-8555-555555555555',
  'b7777777-7777-4777-8777-777777777777',
  'inspection_followup',
  NOW() + INTERVAL '1 hour',
  60,
  'pending'
)
ON CONFLICT (id) DO NOTHING;
