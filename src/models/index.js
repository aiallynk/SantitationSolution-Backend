const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const commonTimestamps = {
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
};

const defineUuidId = () => ({
  type: DataTypes.UUID,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
});

const PlatformUser = sequelize.define(
  'PlatformUser',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    geography_type: { type: DataTypes.STRING(80), allowNull: true },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    full_name: { type: DataTypes.STRING(180), allowNull: false },
    email: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    phone: { type: DataTypes.STRING(32), allowNull: true, unique: true },
    employee_code: { type: DataTypes.STRING(64), allowNull: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: true },
    auth_provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'local' },
    status: { type: DataTypes.ENUM('active', 'inactive', 'locked'), allowNull: false, defaultValue: 'active' },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'platform_users', timestamps: false }
);

const Role = sequelize.define(
  'Role',
  {
    id: defineUuidId(),
    code: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(180), allowNull: false },
    description: { type: DataTypes.STRING(400), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'roles', timestamps: false }
);

const Permission = sequelize.define(
  'Permission',
  {
    id: defineUuidId(),
    code: { type: DataTypes.STRING(150), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(180), allowNull: false },
    description: { type: DataTypes.STRING(400), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'permissions', timestamps: false }
);

const RolePermission = sequelize.define(
  'RolePermission',
  {
    id: defineUuidId(),
    role_id: { type: DataTypes.UUID, allowNull: false },
    permission_id: { type: DataTypes.UUID, allowNull: false },
    ...commonTimestamps,
  },
  { tableName: 'role_permissions', timestamps: false }
);

const UserRole = sequelize.define(
  'UserRole',
  {
    id: defineUuidId(),
    user_id: { type: DataTypes.UUID, allowNull: false },
    role_id: { type: DataTypes.UUID, allowNull: false },
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'user_roles', timestamps: false }
);

const WorkerAssignment = sequelize.define(
  'WorkerAssignment',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    facility_id: { type: DataTypes.UUID, allowNull: true },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    assignment_level: {
      type: DataTypes.ENUM('tenant', 'geography', 'facility', 'toilet_unit'),
      allowNull: false,
      defaultValue: 'facility',
    },
    assignment_role: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'worker' },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    created_by_user_id: { type: DataTypes.UUID, allowNull: true },
    updated_by_user_id: { type: DataTypes.UUID, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'worker_assignments', timestamps: false }
);

const Tenant = sequelize.define(
  'Tenant',
  {
    id: defineUuidId(),
    name: { type: DataTypes.STRING(200), allowNull: false },
    code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    country_code: { type: DataTypes.STRING(10), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'tenants', timestamps: false }
);

const Geography = sequelize.define(
  'Geography',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    parent_id: { type: DataTypes.UUID, allowNull: true },
    level: {
      type: DataTypes.ENUM('country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'),
      allowNull: false,
    },
    code: { type: DataTypes.STRING(120), allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    centroid_latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    centroid_longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'geographies', timestamps: false }
);

const Facility = sequelize.define(
  'Facility',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(220), allowNull: false },
    facility_type: { type: DataTypes.STRING(80), allowNull: false },
    address_line: { type: DataTypes.STRING(300), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'maintenance'),
      allowNull: false,
      defaultValue: 'active',
    },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'facilities', timestamps: false }
);

const ToiletBlock = sequelize.define(
  'ToiletBlock',
  {
    id: defineUuidId(),
    facility_id: { type: DataTypes.UUID, allowNull: false },
    code: { type: DataTypes.STRING(120), allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    gender_type: { type: DataTypes.STRING(40), allowNull: true },
    status: { type: DataTypes.ENUM('active', 'inactive', 'maintenance'), allowNull: false, defaultValue: 'active' },
    ...commonTimestamps,
  },
  { tableName: 'toilet_blocks', timestamps: false }
);

const ToiletUnit = sequelize.define(
  'ToiletUnit',
  {
    id: defineUuidId(),
    facility_id: { type: DataTypes.UUID, allowNull: false },
    toilet_block_id: { type: DataTypes.UUID, allowNull: false },
    code: { type: DataTypes.STRING(120), allowNull: false },
    qr_code: { type: DataTypes.STRING(180), allowNull: false },
    unit_type: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.ENUM('clean', 'moderate', 'poor', 'critical', 'out_of_service'), allowNull: false, defaultValue: 'moderate' },
    ...commonTimestamps,
  },
  { tableName: 'toilet_units', timestamps: false }
);

const InspectionTask = sequelize.define(
  'InspectionTask',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    facility_id: { type: DataTypes.UUID, allowNull: false },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    assigned_to_user_id: { type: DataTypes.UUID, allowNull: false },
    task_type: { type: DataTypes.STRING(50), allowNull: false },
    scheduled_at: { type: DataTypes.DATE, allowNull: false },
    sla_minutes: { type: DataTypes.INTEGER, allowNull: true },
    status: {
      type: DataTypes.ENUM('pending', 'in_progress', 'completed', 'cancelled', 'overdue'),
      allowNull: false,
      defaultValue: 'pending',
    },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'inspection_tasks', timestamps: false }
);

const Inspection = sequelize.define(
  'Inspection',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    task_id: { type: DataTypes.UUID, allowNull: true },
    facility_id: { type: DataTypes.UUID, allowNull: false },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    inspector_user_id: { type: DataTypes.UUID, allowNull: false },
    inspection_type: {
      type: DataTypes.ENUM('before_cleaning', 'after_cleaning', 'surprise_audit', 'complaint_based'),
      allowNull: false,
      defaultValue: 'before_cleaning',
    },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    captured_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    submitted_at: { type: DataTypes.DATE, allowNull: true },
    processing_status: {
      type: DataTypes.ENUM('draft', 'queued', 'processing', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'draft',
    },
    overall_status: {
      type: DataTypes.ENUM('clean', 'moderate', 'poor', 'critical'),
      allowNull: true,
    },
    ...commonTimestamps,
  },
  { tableName: 'inspections', timestamps: false }
);

const InspectionMedia = sequelize.define(
  'InspectionMedia',
  {
    id: defineUuidId(),
    inspection_id: { type: DataTypes.UUID, allowNull: true },
    media_type: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'image' },
    capture_stage: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'evidence' },
    file_url: { type: DataTypes.STRING(500), allowNull: true },
    storage_key: { type: DataTypes.STRING(500), allowNull: true },
    thumbnail_url: { type: DataTypes.STRING(500), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    uploaded_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'inspection_media', timestamps: false }
);

const AiAnalysisResult = sequelize.define(
  'AiAnalysisResult',
  {
    id: defineUuidId(),
    inspection_id: { type: DataTypes.UUID, allowNull: false },
    model_name: { type: DataTypes.STRING(120), allowNull: false },
    model_version: { type: DataTypes.STRING(80), allowNull: false },
    cleanliness_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    hygiene_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    odor_risk_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    wetness_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    stain_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    litter_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    anomaly_flags: { type: DataTypes.JSONB, allowNull: true },
    raw_result: { type: DataTypes.JSONB, allowNull: true },
    processed_at: { type: DataTypes.DATE, allowNull: false },
    ...commonTimestamps,
  },
  { tableName: 'ai_analysis_results', timestamps: false }
);

const SensorDevice = sequelize.define(
  'SensorDevice',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    facility_id: { type: DataTypes.UUID, allowNull: true },
    toilet_block_id: { type: DataTypes.UUID, allowNull: true },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    device_id: { type: DataTypes.STRING(140), allowNull: false, unique: true },
    serial_no: { type: DataTypes.STRING(140), allowNull: true },
    device_type: { type: DataTypes.STRING(60), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'inactive', 'faulty'), allowNull: false, defaultValue: 'active' },
    firmware_version: { type: DataTypes.STRING(80), allowNull: true },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'sensor_devices', timestamps: false }
);

const SensorReading = sequelize.define(
  'SensorReading',
  {
    id: defineUuidId(),
    device_id: { type: DataTypes.UUID, allowNull: false },
    timestamp: { type: DataTypes.DATE, allowNull: false },
    odor_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    ammonia_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    h2s_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    methane_ppm: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    humidity: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    temperature: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    occupancy_count: { type: DataTypes.INTEGER, allowNull: true },
    footfall_count: { type: DataTypes.INTEGER, allowNull: true },
    tank_fill_level: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    battery_level: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    signal_strength: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    raw_payload: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'sensor_readings', timestamps: false }
);

const Alert = sequelize.define(
  'Alert',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    alert_type: { type: DataTypes.STRING(80), allowNull: false },
    severity: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false },
    source_type: { type: DataTypes.ENUM('sensor', 'ai_analysis', 'manual', 'system'), allowNull: false },
    source_id: { type: DataTypes.UUID, allowNull: true },
    facility_id: { type: DataTypes.UUID, allowNull: true },
    message: { type: DataTypes.STRING(600), allowNull: false },
    status: { type: DataTypes.ENUM('open', 'acknowledged', 'resolved'), allowNull: false, defaultValue: 'open' },
    assigned_to_user_id: { type: DataTypes.UUID, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    acknowledged_at: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'alerts', timestamps: false }
);

const CleaningEvent = sequelize.define(
  'CleaningEvent',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    facility_id: { type: DataTypes.UUID, allowNull: false },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    worker_id: { type: DataTypes.UUID, allowNull: false },
    start_time: { type: DataTypes.DATE, allowNull: false },
    end_time: { type: DataTypes.DATE, allowNull: true },
    method: { type: DataTypes.STRING(120), allowNull: true },
    chemical_used: { type: DataTypes.STRING(120), allowNull: true },
    remarks: { type: DataTypes.STRING(600), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'cleaning_events', timestamps: false }
);

const Complaint = sequelize.define(
  'Complaint',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    facility_id: { type: DataTypes.UUID, allowNull: true },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    reporter_user_id: { type: DataTypes.UUID, allowNull: true },
    complaint_type: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(1000), allowNull: false },
    status: { type: DataTypes.ENUM('open', 'assigned', 'resolved', 'rejected'), allowNull: false, defaultValue: 'open' },
    assigned_to_user_id: { type: DataTypes.UUID, allowNull: true },
    priority: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false, defaultValue: 'medium' },
    ...commonTimestamps,
  },
  { tableName: 'complaints', timestamps: false }
);

const NotificationEvent = sequelize.define(
  'NotificationEvent',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    user_id: { type: DataTypes.UUID, allowNull: true },
    event_type: { type: DataTypes.STRING(120), allowNull: false },
    channel: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'in_app' },
    payload: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.ENUM('queued', 'sent', 'failed'), allowNull: false, defaultValue: 'queued' },
    sent_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'notification_events', timestamps: false }
);

const AuditLog = sequelize.define(
  'AuditLog',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    actor_user_id: { type: DataTypes.UUID, allowNull: true },
    action: { type: DataTypes.STRING(120), allowNull: false },
    entity_type: { type: DataTypes.STRING(120), allowNull: false },
    entity_id: { type: DataTypes.STRING(120), allowNull: true },
    request_id: { type: DataTypes.STRING(120), allowNull: true },
    ip_address: { type: DataTypes.STRING(60), allowNull: true },
    user_agent: { type: DataTypes.STRING(400), allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'audit_logs', timestamps: false }
);

const LoginSession = sequelize.define(
  'LoginSession',
  {
    id: defineUuidId(),
    user_id: { type: DataTypes.UUID, allowNull: false },
    refresh_token_hash: { type: DataTypes.STRING(255), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    ip_address: { type: DataTypes.STRING(60), allowNull: true },
    user_agent: { type: DataTypes.STRING(400), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'login_sessions', timestamps: false }
);

const DashboardAggregate = sequelize.define(
  'DashboardAggregate',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    facility_id: { type: DataTypes.UUID, allowNull: true },
    aggregate_date: { type: DataTypes.DATEONLY, allowNull: false },
    metrics: { type: DataTypes.JSONB, allowNull: false },
    ...commonTimestamps,
  },
  { tableName: 'dashboard_aggregates', timestamps: false }
);

const StorageUsageMetric = sequelize.define(
  'StorageUsageMetric',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    bucket_name: { type: DataTypes.STRING(180), allowNull: false },
    used_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    object_count: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    measured_at: { type: DataTypes.DATE, allowNull: false },
    ...commonTimestamps,
  },
  { tableName: 'storage_usage_metrics', timestamps: false }
);

const IntegrationConfig = sequelize.define(
  'IntegrationConfig',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING(180), allowNull: false },
    config_type: { type: DataTypes.STRING(120), allowNull: false },
    config_json: { type: DataTypes.JSONB, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...commonTimestamps,
  },
  { tableName: 'integration_configs', timestamps: false }
);

const SuperAdminProject = sequelize.define(
  'SuperAdminProject',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING(220), allowNull: false },
    code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    category: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'deployment' },
    status: {
      type: DataTypes.ENUM('planned', 'active', 'on_hold', 'completed', 'cancelled'),
      allowNull: false,
      defaultValue: 'planned',
    },
    starts_at: { type: DataTypes.DATE, allowNull: true },
    ends_at: { type: DataTypes.DATE, allowNull: true },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_projects', timestamps: false }
);

const SuperAdminApproval = sequelize.define(
  'SuperAdminApproval',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    requested_by_user_id: { type: DataTypes.UUID, allowNull: true },
    reviewed_by_user_id: { type: DataTypes.UUID, allowNull: true },
    category: { type: DataTypes.STRING(120), allowNull: false },
    entity_type: { type: DataTypes.STRING(120), allowNull: false },
    entity_id: { type: DataTypes.STRING(120), allowNull: true },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    notes: { type: DataTypes.STRING(800), allowNull: true },
    reviewed_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_approvals', timestamps: false }
);

const SuperAdminSupportTicket = sequelize.define(
  'SuperAdminSupportTicket',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    opened_by_user_id: { type: DataTypes.UUID, allowNull: true },
    assigned_to_user_id: { type: DataTypes.UUID, allowNull: true },
    subject: { type: DataTypes.STRING(240), allowNull: false },
    description: { type: DataTypes.STRING(2000), allowNull: false },
    severity: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false, defaultValue: 'medium' },
    status: {
      type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed'),
      allowNull: false,
      defaultValue: 'open',
    },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_support_tickets', timestamps: false }
);

const SuperAdminReleaseRecord = sequelize.define(
  'SuperAdminReleaseRecord',
  {
    id: defineUuidId(),
    version: { type: DataTypes.STRING(80), allowNull: false },
    environment: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'staging' },
    status: {
      type: DataTypes.ENUM('planned', 'running', 'success', 'failed', 'rolled_back'),
      allowNull: false,
      defaultValue: 'planned',
    },
    deployed_by_user_id: { type: DataTypes.UUID, allowNull: true },
    deployed_at: { type: DataTypes.DATE, allowNull: true },
    notes: { type: DataTypes.STRING(1200), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_release_records', timestamps: false }
);

const SuperAdminBackupRecord = sequelize.define(
  'SuperAdminBackupRecord',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    backup_type: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'database' },
    storage_key: { type: DataTypes.STRING(500), allowNull: true },
    size_bytes: { type: DataTypes.BIGINT, allowNull: true },
    status: { type: DataTypes.ENUM('queued', 'running', 'completed', 'failed'), allowNull: false, defaultValue: 'queued' },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    retention_until: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_backup_records', timestamps: false }
);

const SuperAdminSyncFailure = sequelize.define(
  'SuperAdminSyncFailure',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    source_module: { type: DataTypes.STRING(120), allowNull: false },
    reference_id: { type: DataTypes.STRING(180), allowNull: true },
    severity: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false, defaultValue: 'medium' },
    reason: { type: DataTypes.STRING(1000), allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: true },
    status: { type: DataTypes.ENUM('open', 'resolved', 'ignored'), allowNull: false, defaultValue: 'open' },
    first_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_sync_failures', timestamps: false }
);

const SuperAdminTenantHealth = sequelize.define(
  'SuperAdminTenantHealth',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    snapshot_at: { type: DataTypes.DATE, allowNull: false },
    health_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    open_alerts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    pending_tasks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed_syncs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active_sensors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_sensors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'super_admin_tenant_health', timestamps: false }
);

const PasswordResetToken = sequelize.define(
  'PasswordResetToken',
  {
    id: defineUuidId(),
    user_id: { type: DataTypes.UUID, allowNull: false },
    token_hash: { type: DataTypes.STRING(255), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'password_reset_tokens', timestamps: false }
);

// Associations
PlatformUser.belongsToMany(Role, { through: UserRole, foreignKey: 'user_id', otherKey: 'role_id' });
Role.belongsToMany(PlatformUser, { through: UserRole, foreignKey: 'role_id', otherKey: 'user_id' });
Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_id', otherKey: 'permission_id' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_id', otherKey: 'role_id' });

PlatformUser.hasMany(UserRole, { foreignKey: 'user_id', as: 'userRoleMemberships' });
UserRole.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });
Role.hasMany(UserRole, { foreignKey: 'role_id', as: 'roleMemberships' });
UserRole.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });
Tenant.hasMany(UserRole, { foreignKey: 'tenant_id', as: 'tenantMemberships' });
UserRole.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Geography.hasMany(UserRole, { foreignKey: 'geography_id', as: 'geographyMemberships' });
UserRole.belongsTo(Geography, { foreignKey: 'geography_id', as: 'geography' });

Tenant.hasMany(PlatformUser, { foreignKey: 'tenant_id' });
PlatformUser.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Tenant.hasMany(Geography, { foreignKey: 'tenant_id' });
Geography.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Tenant.hasMany(Facility, { foreignKey: 'tenant_id' });
Facility.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Facility.belongsTo(Geography, { foreignKey: 'geography_id' });
Geography.hasMany(Facility, { foreignKey: 'geography_id' });

Facility.hasMany(ToiletBlock, { foreignKey: 'facility_id' });
ToiletBlock.belongsTo(Facility, { foreignKey: 'facility_id' });
Facility.hasMany(ToiletUnit, { foreignKey: 'facility_id' });
ToiletUnit.belongsTo(Facility, { foreignKey: 'facility_id' });
ToiletBlock.hasMany(ToiletUnit, { foreignKey: 'toilet_block_id' });
ToiletUnit.belongsTo(ToiletBlock, { foreignKey: 'toilet_block_id' });

Tenant.hasMany(WorkerAssignment, { foreignKey: 'tenant_id' });
WorkerAssignment.belongsTo(Tenant, { foreignKey: 'tenant_id' });
PlatformUser.hasMany(WorkerAssignment, { foreignKey: 'user_id', as: 'assignments' });
WorkerAssignment.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });
Geography.hasMany(WorkerAssignment, { foreignKey: 'geography_id', as: 'assignments' });
WorkerAssignment.belongsTo(Geography, { foreignKey: 'geography_id', as: 'geography' });
Facility.hasMany(WorkerAssignment, { foreignKey: 'facility_id', as: 'assignments' });
WorkerAssignment.belongsTo(Facility, { foreignKey: 'facility_id', as: 'facility' });
ToiletUnit.hasMany(WorkerAssignment, { foreignKey: 'toilet_unit_id', as: 'assignments' });
WorkerAssignment.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id', as: 'toiletUnit' });
PlatformUser.hasMany(WorkerAssignment, { foreignKey: 'created_by_user_id', as: 'createdAssignments' });
WorkerAssignment.belongsTo(PlatformUser, { foreignKey: 'created_by_user_id', as: 'createdBy' });
PlatformUser.hasMany(WorkerAssignment, { foreignKey: 'updated_by_user_id', as: 'updatedAssignments' });
WorkerAssignment.belongsTo(PlatformUser, { foreignKey: 'updated_by_user_id', as: 'updatedBy' });

InspectionTask.belongsTo(PlatformUser, { foreignKey: 'assigned_to_user_id', as: 'assignee' });
InspectionTask.belongsTo(Facility, { foreignKey: 'facility_id' });
InspectionTask.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
Inspection.belongsTo(InspectionTask, { foreignKey: 'task_id' });
Inspection.belongsTo(Facility, { foreignKey: 'facility_id' });
Inspection.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
Inspection.belongsTo(PlatformUser, { foreignKey: 'inspector_user_id', as: 'inspector' });
Inspection.hasMany(InspectionMedia, { foreignKey: 'inspection_id' });
InspectionMedia.belongsTo(Inspection, { foreignKey: 'inspection_id' });
Inspection.hasMany(AiAnalysisResult, { foreignKey: 'inspection_id' });
AiAnalysisResult.belongsTo(Inspection, { foreignKey: 'inspection_id' });

SensorDevice.belongsTo(Facility, { foreignKey: 'facility_id' });
SensorDevice.belongsTo(ToiletBlock, { foreignKey: 'toilet_block_id' });
SensorDevice.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
SensorDevice.hasMany(SensorReading, { foreignKey: 'device_id', sourceKey: 'id' });
SensorReading.belongsTo(SensorDevice, { foreignKey: 'device_id', targetKey: 'id' });

Alert.belongsTo(Facility, { foreignKey: 'facility_id' });
Alert.belongsTo(PlatformUser, { foreignKey: 'assigned_to_user_id', as: 'assignee' });
Complaint.belongsTo(Facility, { foreignKey: 'facility_id' });
Complaint.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
Complaint.belongsTo(PlatformUser, { foreignKey: 'reporter_user_id', as: 'reporter' });
Complaint.belongsTo(PlatformUser, { foreignKey: 'assigned_to_user_id', as: 'assignedTo' });
AuditLog.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(AuditLog, { foreignKey: 'tenant_id', as: 'auditLogs' });
AuditLog.belongsTo(PlatformUser, { foreignKey: 'actor_user_id', as: 'actor' });
PlatformUser.hasMany(AuditLog, { foreignKey: 'actor_user_id', as: 'auditLogs' });
LoginSession.belongsTo(PlatformUser, { foreignKey: 'user_id' });
PasswordResetToken.belongsTo(PlatformUser, { foreignKey: 'user_id' });
SuperAdminProject.belongsTo(Tenant, { foreignKey: 'tenant_id' });
SuperAdminProject.belongsTo(Geography, { foreignKey: 'geography_id' });
SuperAdminApproval.belongsTo(Tenant, { foreignKey: 'tenant_id' });
SuperAdminApproval.belongsTo(PlatformUser, { foreignKey: 'requested_by_user_id', as: 'requester' });
SuperAdminApproval.belongsTo(PlatformUser, { foreignKey: 'reviewed_by_user_id', as: 'reviewer' });
SuperAdminSupportTicket.belongsTo(Tenant, { foreignKey: 'tenant_id' });
SuperAdminSupportTicket.belongsTo(PlatformUser, { foreignKey: 'opened_by_user_id', as: 'openedBy' });
SuperAdminSupportTicket.belongsTo(PlatformUser, { foreignKey: 'assigned_to_user_id', as: 'assignedTo' });
SuperAdminReleaseRecord.belongsTo(PlatformUser, { foreignKey: 'deployed_by_user_id', as: 'deployedBy' });
SuperAdminBackupRecord.belongsTo(Tenant, { foreignKey: 'tenant_id' });
SuperAdminSyncFailure.belongsTo(Tenant, { foreignKey: 'tenant_id' });
SuperAdminTenantHealth.belongsTo(Tenant, { foreignKey: 'tenant_id' });

module.exports = {
  sequelize,
  PlatformUser,
  Role,
  Permission,
  RolePermission,
  UserRole,
  WorkerAssignment,
  Tenant,
  Geography,
  Facility,
  ToiletBlock,
  ToiletUnit,
  InspectionTask,
  Inspection,
  InspectionMedia,
  AiAnalysisResult,
  SensorDevice,
  SensorReading,
  Alert,
  CleaningEvent,
  Complaint,
  NotificationEvent,
  AuditLog,
  LoginSession,
  DashboardAggregate,
  StorageUsageMetric,
  IntegrationConfig,
  SuperAdminProject,
  SuperAdminApproval,
  SuperAdminSupportTicket,
  SuperAdminReleaseRecord,
  SuperAdminBackupRecord,
  SuperAdminSyncFailure,
  SuperAdminTenantHealth,
  PasswordResetToken,
};
