-- 20260327_001_core_schema.sql
-- PostgreSQL migration for sanitation platform core entities.
-- NOTE: "users" in product requirements is implemented as `platform_users` for backend compatibility.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  code VARCHAR(120) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  country_code VARCHAR(10),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geographies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES geographies(id) ON DELETE SET NULL,
  level VARCHAR(20) NOT NULL CHECK (level IN ('country','state','district','city','zone','ward','cluster')),
  code VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  centroid_latitude NUMERIC(10,7),
  centroid_longitude NUMERIC(10,7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, level, code)
);
CREATE INDEX IF NOT EXISTS idx_geographies_tenant_level ON geographies(tenant_id, level);
CREATE INDEX IF NOT EXISTS idx_geographies_parent ON geographies(parent_id);

CREATE TABLE IF NOT EXISTS platform_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  geography_id UUID REFERENCES geographies(id) ON DELETE SET NULL,
  full_name VARCHAR(180) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  phone VARCHAR(32) UNIQUE,
  password_hash VARCHAR(255),
  auth_provider VARCHAR(40) NOT NULL DEFAULT 'local',
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','locked')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_users_tenant_status ON platform_users(tenant_id, status);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  description VARCHAR(400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  geography_id UUID REFERENCES geographies(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id, tenant_id, geography_id)
);

CREATE TABLE IF NOT EXISTS facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geography_id UUID REFERENCES geographies(id) ON DELETE SET NULL,
  code VARCHAR(120) NOT NULL UNIQUE,
  name VARCHAR(220) NOT NULL,
  facility_type VARCHAR(80) NOT NULL,
  address_line VARCHAR(300),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance')),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_facilities_tenant_geography ON facilities(tenant_id, geography_id);
CREATE INDEX IF NOT EXISTS idx_facilities_lat_lng ON facilities(latitude, longitude);

CREATE TABLE IF NOT EXISTS toilet_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  code VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  gender_type VARCHAR(40),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (facility_id, code)
);

CREATE TABLE IF NOT EXISTS toilet_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  toilet_block_id UUID NOT NULL REFERENCES toilet_blocks(id) ON DELETE CASCADE,
  code VARCHAR(120) NOT NULL,
  qr_code VARCHAR(180) NOT NULL UNIQUE,
  unit_type VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'moderate' CHECK (status IN ('clean','moderate','poor','critical','out_of_service')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (toilet_block_id, code)
);

CREATE TABLE IF NOT EXISTS inspection_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  toilet_unit_id UUID REFERENCES toilet_units(id) ON DELETE SET NULL,
  assigned_to_user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  task_type VARCHAR(50) NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sla_minutes INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled','overdue')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspection_tasks_assignee_status_scheduled
  ON inspection_tasks(assigned_to_user_id, status, scheduled_at);

CREATE TABLE IF NOT EXISTS inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID REFERENCES inspection_tasks(id) ON DELETE SET NULL,
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  toilet_unit_id UUID REFERENCES toilet_units(id) ON DELETE SET NULL,
  inspector_user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  inspection_type VARCHAR(30) NOT NULL DEFAULT 'before_cleaning' CHECK (inspection_type IN ('before_cleaning','after_cleaning','surprise_audit','complaint_based')),
  notes VARCHAR(1000),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  processing_status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (processing_status IN ('draft','queued','processing','completed','failed')),
  overall_status VARCHAR(20) CHECK (overall_status IN ('clean','moderate','poor','critical')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspections_tenant_captured ON inspections(tenant_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_inspections_processing_status ON inspections(processing_status);
CREATE INDEX IF NOT EXISTS idx_inspections_facility_unit ON inspections(facility_id, toilet_unit_id);

CREATE TABLE IF NOT EXISTS inspection_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID REFERENCES inspections(id) ON DELETE SET NULL,
  media_type VARCHAR(40) NOT NULL DEFAULT 'image',
  capture_stage VARCHAR(40) NOT NULL DEFAULT 'evidence',
  file_url VARCHAR(500),
  storage_key VARCHAR(500),
  thumbnail_url VARCHAR(500),
  metadata JSONB,
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspection_media_inspection_stage ON inspection_media(inspection_id, capture_stage);

CREATE TABLE IF NOT EXISTS ai_analysis_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  model_name VARCHAR(120) NOT NULL,
  model_version VARCHAR(80) NOT NULL,
  cleanliness_score NUMERIC(5,2) NOT NULL CHECK (cleanliness_score >= 0 AND cleanliness_score <= 100),
  hygiene_score NUMERIC(5,2) NOT NULL CHECK (hygiene_score >= 0 AND hygiene_score <= 100),
  odor_risk_score NUMERIC(5,2) NOT NULL CHECK (odor_risk_score >= 0 AND odor_risk_score <= 100),
  wetness_score NUMERIC(5,2) NOT NULL CHECK (wetness_score >= 0 AND wetness_score <= 100),
  stain_score NUMERIC(5,2) NOT NULL CHECK (stain_score >= 0 AND stain_score <= 100),
  litter_score NUMERIC(5,2) NOT NULL CHECK (litter_score >= 0 AND litter_score <= 100),
  anomaly_flags JSONB,
  raw_result JSONB,
  processed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_results_inspection_processed ON ai_analysis_results(inspection_id, processed_at);

CREATE TABLE IF NOT EXISTS sensor_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id) ON DELETE SET NULL,
  toilet_block_id UUID REFERENCES toilet_blocks(id) ON DELETE SET NULL,
  toilet_unit_id UUID REFERENCES toilet_units(id) ON DELETE SET NULL,
  device_id VARCHAR(140) NOT NULL UNIQUE,
  serial_no VARCHAR(140),
  device_type VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','faulty')),
  firmware_version VARCHAR(80),
  last_seen_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sensor_devices_tenant_status ON sensor_devices(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sensor_devices_facility ON sensor_devices(facility_id);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES sensor_devices(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL,
  ppm NUMERIC(10,2),
  humidity NUMERIC(10,2),
  temperature NUMERIC(10,2),
  occupancy_count INTEGER,
  footfall_count INTEGER,
  tank_fill_level NUMERIC(10,2),
  battery_level NUMERIC(10,2),
  signal_strength NUMERIC(10,2),
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_device_timestamp ON sensor_readings(device_id, timestamp);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_type VARCHAR(80) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('sensor','ai_analysis','manual','system')),
  source_id UUID,
  facility_id UUID REFERENCES facilities(id) ON DELETE SET NULL,
  message VARCHAR(600) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  assigned_to_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_status_severity ON alerts(tenant_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_alerts_facility_created ON alerts(facility_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(120) NOT NULL,
  entity_id VARCHAR(120),
  request_id VARCHAR(120),
  ip_address VARCHAR(60),
  user_agent VARCHAR(400),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
