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
    geography_id: { type: DataTypes.UUID, allowNull: true },
    user_id_code: { type: DataTypes.STRING(40), allowNull: true, unique: true },
    full_name: { type: DataTypes.STRING(180), allowNull: false },
    email: { type: DataTypes.STRING(180), allowNull: false, unique: true },
    phone: { type: DataTypes.STRING(32), allowNull: true, unique: true },
    employee_code: { type: DataTypes.STRING(64), allowNull: true },
    remarks: { type: DataTypes.STRING(500), allowNull: true },
    country_name: { type: DataTypes.STRING(120), allowNull: true },
    state_name: { type: DataTypes.STRING(120), allowNull: true },
    district_name: { type: DataTypes.STRING(120), allowNull: true },
    city_name: { type: DataTypes.STRING(120), allowNull: true },
    zone_name: { type: DataTypes.STRING(120), allowNull: true },
    ward_name: { type: DataTypes.STRING(120), allowNull: true },
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
    supervisor_user_id: { type: DataTypes.UUID, allowNull: true },
    assignment_level: {
      type: DataTypes.ENUM(
        'tenant',
        'country',
        'state',
        'district',
        'city',
        'zone',
        'ward',
        'geography',
        'facility',
        'toilet_unit'
      ),
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
    contact_name: { type: DataTypes.STRING(180), allowNull: true },
    contact_email: { type: DataTypes.STRING(180), allowNull: true },
    contact_mobile: { type: DataTypes.STRING(32), allowNull: true },
    scope_level: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'city' },
    country_name: { type: DataTypes.STRING(120), allowNull: true },
    state_name: { type: DataTypes.STRING(120), allowNull: true },
    district_name: { type: DataTypes.STRING(120), allowNull: true },
    city_name: { type: DataTypes.STRING(120), allowNull: true },
    zone_name: { type: DataTypes.STRING(120), allowNull: true },
    address_line: { type: DataTypes.STRING(300), allowNull: true },
    root_geography_id: { type: DataTypes.UUID, allowNull: true },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'Asia/Kolkata' },
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
    geometry_type: { type: DataTypes.STRING(20), allowNull: true },
    geojson: { type: DataTypes.JSONB, allowNull: true },
    boundary_center_latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    boundary_center_longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    boundary_radius_meters: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    bounds: { type: DataTypes.JSONB, allowNull: true },
    area_sq_km: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    boundary_label: { type: DataTypes.STRING(220), allowNull: true },
    is_operational_zone: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
    zone_geography_id: { type: DataTypes.UUID, allowNull: true },
    ward_geography_id: { type: DataTypes.UUID, allowNull: true },
    supervisor_user_id: { type: DataTypes.UUID, allowNull: true },
    code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(220), allowNull: false },
    facility_type: { type: DataTypes.STRING(80), allowNull: false },
    address_line: { type: DataTypes.STRING(300), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    timezone: { type: DataTypes.STRING(64), allowNull: true },
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
    is_public_visible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sector_code: { type: DataTypes.STRING(40), allowNull: true },
    location_label: { type: DataTypes.STRING(300), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    latest_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    latest_before_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    latest_after_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    avg_before_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    avg_after_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    avg_improvement_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    last_inspection_at: { type: DataTypes.DATE, allowNull: true },
    last_cleaned_at: { type: DataTypes.DATE, allowNull: true },
    total_inspections: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    dirty_frequency: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
    low_performance_frequency: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
    deactivated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_reason: { type: DataTypes.TEXT, allowNull: true },
    lifecycle_updated_by: { type: DataTypes.UUID, allowNull: true },
    timezone: { type: DataTypes.STRING(64), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'toilet_units', timestamps: false }
);

const ToiletQrCode = sequelize.define(
  'ToiletQrCode',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: false },
    qr_code: { type: DataTypes.STRING(220), allowNull: false },
    schema_version: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'legacy_v1' },
    qr_payload: { type: DataTypes.JSONB, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_by_user_id: { type: DataTypes.UUID, allowNull: true },
    updated_by_user_id: { type: DataTypes.UUID, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'toilet_qr_codes', timestamps: false }
);

const InspectionTask = sequelize.define(
  'InspectionTask',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    facility_id: { type: DataTypes.UUID, allowNull: false },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    complaint_id: { type: DataTypes.UUID, allowNull: true },
    assigned_to_user_id: { type: DataTypes.UUID, allowNull: true },
    assigned_by_user_id: { type: DataTypes.UUID, allowNull: true },
    task_type: { type: DataTypes.STRING(50), allowNull: false },
    title: { type: DataTypes.STRING(220), allowNull: true },
    description: { type: DataTypes.STRING(1200), allowNull: true },
    priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'medium' },
    scheduled_at: { type: DataTypes.DATE, allowNull: false },
    sla_minutes: { type: DataTypes.INTEGER, allowNull: true },
    status: {
      type: DataTypes.ENUM(
        'unassigned',
        'assigned',
        'accepted',
        'pending',
        'in_progress',
        'completed',
        'cancelled',
        'overdue'
      ),
      allowNull: false,
      defaultValue: 'pending',
    },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    due_at: { type: DataTypes.DATE, allowNull: true },
    accepted_at: { type: DataTypes.DATE, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    assignment_source: { type: DataTypes.STRING(40), allowNull: true },
    assignment_reason: { type: DataTypes.STRING(600), allowNull: true },
    distance_km: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    worker_location_snapshot: { type: DataTypes.JSONB, allowNull: true },
    critical_detected_at: { type: DataTypes.DATE, allowNull: true },
    reminder_state: { type: DataTypes.JSONB, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'inspection_tasks', timestamps: false }
);

const WorkerHeartbeat = sequelize.define(
  'WorkerHeartbeat',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    worker_id: { type: DataTypes.UUID, allowNull: false },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    accuracy: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    speed: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    heading: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    mobile_battery_percentage: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    is_charging: { type: DataTypes.BOOLEAN, allowNull: true },
    source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'mobile_app' },
    captured_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'worker_heartbeats', timestamps: false }
);

const TaskAssignmentLog = sequelize.define(
  'TaskAssignmentLog',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    task_id: { type: DataTypes.UUID, allowNull: false },
    complaint_id: { type: DataTypes.UUID, allowNull: true },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    worker_id: { type: DataTypes.UUID, allowNull: true },
    supervisor_user_id: { type: DataTypes.UUID, allowNull: true },
    assigned_by_user_id: { type: DataTypes.UUID, allowNull: true },
    assignment_source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'automation' },
    reason: { type: DataTypes.STRING(800), allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'created' },
    distance_km: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    worker_location_snapshot: { type: DataTypes.JSONB, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'task_assignment_logs', timestamps: false }
);

const TaskReminderLog = sequelize.define(
  'TaskReminderLog',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    task_id: { type: DataTypes.UUID, allowNull: false },
    worker_id: { type: DataTypes.UUID, allowNull: true },
    reminder_type: { type: DataTypes.STRING(60), allowNull: false },
    sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'sent' },
    channel: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'in_app' },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'task_reminder_logs', timestamps: false }
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
    captured_at_utc: { type: DataTypes.DATE, allowNull: true },
    capture_timezone: { type: DataTypes.STRING(64), allowNull: true },
    capture_offset_minutes: { type: DataTypes.INTEGER, allowNull: true },
    capture_time_source: { type: DataTypes.STRING(40), allowNull: true },
    submitted_at: { type: DataTypes.DATE, allowNull: true },
    processing_status: {
      type: DataTypes.ENUM('draft', 'queued', 'processing', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'draft',
    },
    pipeline_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'draft' },
    pipeline_counters: { type: DataTypes.JSONB, allowNull: true },
    review_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_processing_error: { type: DataTypes.STRING(2000), allowNull: true },
    assignment_id: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'DRAFT' },
    before_image_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    after_image_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    avg_before_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    avg_after_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    improvement_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    confidence_avg: { type: DataTypes.DECIMAL(6, 4), allowNull: true },
    inspection_result: { type: DataTypes.STRING(40), allowNull: true },
    before_issue_tags: { type: DataTypes.JSONB, allowNull: true },
    after_issue_tags: { type: DataTypes.JSONB, allowNull: true },
    resolved_issues: { type: DataTypes.JSONB, allowNull: true },
    remaining_issues: { type: DataTypes.JSONB, allowNull: true },
    suspicious_flag: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    suspicious_reasons: { type: DataTypes.JSONB, allowNull: true },
    validation_failed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rejected_image_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_scored_at: { type: DataTypes.DATE, allowNull: true },
    overall_status: {
      type: DataTypes.ENUM('clean', 'moderate', 'poor', 'critical'),
      allowNull: true,
    },
    // Optional snapshot of the BLE sensor reading at inspection time. Never required
    // for submit/scoring; NULL when no sensor was connected.
    sensor_snapshot: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'inspections', timestamps: false }
);

const InspectionMedia = sequelize.define(
  'InspectionMedia',
  {
    id: defineUuidId(),
    inspection_id: { type: DataTypes.UUID, allowNull: true },
    toilet_unit_id: { type: DataTypes.UUID, allowNull: true },
    worker_id: { type: DataTypes.UUID, allowNull: true },
    assignment_id: { type: DataTypes.UUID, allowNull: true },
    client_image_id: { type: DataTypes.STRING(120), allowNull: true },
    media_type: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'image' },
    capture_stage: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'evidence' },
    upload_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'pending' },
    processing_state: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'captured' },
    retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ai_attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_retry_at: { type: DataTypes.DATE, allowNull: true },
    next_retry_at: { type: DataTypes.DATE, allowNull: true },
    last_error_code: { type: DataTypes.STRING(120), allowNull: true },
    last_error_message: { type: DataTypes.STRING(2000), allowNull: true },
    manual_review_required_at: { type: DataTypes.DATE, allowNull: true },
    storage_verified_at: { type: DataTypes.DATE, allowNull: true },
    ai_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'PENDING_UPLOAD' },
    image_quality_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'unknown' },
    image_quality_score: { type: DataTypes.DECIMAL(6, 4), allowNull: true },
    toilet_detected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    validation_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'PENDING' },
    validation_reason: { type: DataTypes.STRING(500), allowNull: true },
    visibility_score: { type: DataTypes.DECIMAL(6, 4), allowNull: true },
    perceptual_hash: { type: DataTypes.STRING(128), allowNull: true },
    similarity_score: { type: DataTypes.DECIMAL(6, 4), allowNull: true },
    etag: { type: DataTypes.STRING(160), allowNull: true },
    sha256: { type: DataTypes.STRING(128), allowNull: true },
    content_length: { type: DataTypes.BIGINT, allowNull: true },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    gps_lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    gps_lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    device_id: { type: DataTypes.STRING(160), allowNull: true },
    watermark_meta: { type: DataTypes.JSONB, allowNull: true },
    captured_at: { type: DataTypes.DATE, allowNull: true },
    captured_at_utc: { type: DataTypes.DATE, allowNull: true },
    capture_timezone: { type: DataTypes.STRING(64), allowNull: true },
    capture_offset_minutes: { type: DataTypes.INTEGER, allowNull: true },
    capture_time_source: { type: DataTypes.STRING(40), allowNull: true },
    confirmed_at: { type: DataTypes.DATE, allowNull: true },
    ordinal: { type: DataTypes.INTEGER, allowNull: true },
    upload_duration_ms: { type: DataTypes.INTEGER, allowNull: true },
    overall_score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    confidence_score: { type: DataTypes.DECIMAL(6, 4), allowNull: true },
    floor_score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    commode_score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    stain_score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    garbage_score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    water_score: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    issue_tags: { type: DataTypes.JSONB, allowNull: true },
    issue_summary: { type: DataTypes.STRING(1000), allowNull: true },
    severity: { type: DataTypes.STRING(20), allowNull: true },
    review_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    model_version: { type: DataTypes.STRING(80), allowNull: true },
    prompt_version: { type: DataTypes.STRING(40), allowNull: true },
    scoring_version: { type: DataTypes.STRING(40), allowNull: true },
    scoring_rejected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    explanation_summary: { type: DataTypes.STRING(2000), allowNull: true },
    ai_processed_at: { type: DataTypes.DATE, allowNull: true },
    ai_error: { type: DataTypes.STRING(2000), allowNull: true },
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
    confidence_score: { type: DataTypes.DECIMAL(6, 4), allowNull: true },
    review_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sub_scores: { type: DataTypes.JSONB, allowNull: true },
    issue_tags: { type: DataTypes.JSONB, allowNull: true },
    severity_label: { type: DataTypes.STRING(40), allowNull: true },
    explanation_text: { type: DataTypes.STRING(2000), allowNull: true },
    processing_ms: { type: DataTypes.INTEGER, allowNull: true },
    schema_version: { type: DataTypes.STRING(40), allowNull: true },
    provider: { type: DataTypes.STRING(40), allowNull: true },
    anomaly_flags: { type: DataTypes.JSONB, allowNull: true },
    raw_result: { type: DataTypes.JSONB, allowNull: true },
    processed_at: { type: DataTypes.DATE, allowNull: false },
    ...commonTimestamps,
  },
  { tableName: 'ai_analysis_results', timestamps: false }
);

const ImageSession = sequelize.define(
  'ImageSession',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    inspection_id: { type: DataTypes.UUID, allowNull: false },
    media_id: { type: DataTypes.UUID, allowNull: true },
    client_submission_id: { type: DataTypes.STRING(120), allowNull: true },
    client_image_id: { type: DataTypes.STRING(120), allowNull: false },
    capture_stage: { type: DataTypes.STRING(40), allowNull: false },
    ordinal: { type: DataTypes.INTEGER, allowNull: true },
    object_key: { type: DataTypes.STRING(500), allowNull: true },
    upload_method: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PUT' },
    content_type: { type: DataTypes.STRING(120), allowNull: false, defaultValue: 'image/jpeg' },
    expected_size: { type: DataTypes.BIGINT, allowNull: true },
    expected_sha256: { type: DataTypes.STRING(128), allowNull: true },
    object_key_locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    reconcile_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reconciled_at: { type: DataTypes.DATE, allowNull: true },
    last_reconcile_error: { type: DataTypes.STRING(1000), allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'created' },
    upload_url_expires_at: { type: DataTypes.DATE, allowNull: true },
    uploaded_at: { type: DataTypes.DATE, allowNull: true },
    confirmed_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'image_sessions', timestamps: false }
);

const InspectionSubmission = sequelize.define(
  'InspectionSubmission',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    inspection_id: { type: DataTypes.UUID, allowNull: false },
    client_submission_id: { type: DataTypes.STRING(120), allowNull: true },
    idempotency_key: { type: DataTypes.STRING(200), allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'queued_for_ai' },
    submitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    acknowledged_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'inspection_submissions', timestamps: false }
);

const AiProcessingJob = sequelize.define(
  'AiProcessingJob',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    inspection_id: { type: DataTypes.UUID, allowNull: false },
    submission_id: { type: DataTypes.UUID, allowNull: true },
    image_id: { type: DataTypes.UUID, allowNull: true },
    job_type: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'AI_ANALYSIS' },
    queue_name: { type: DataTypes.STRING(120), allowNull: false },
    queue_job_id: { type: DataTypes.STRING(180), allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'queued' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    leased_until: { type: DataTypes.DATE, allowNull: true },
    last_heartbeat_at: { type: DataTypes.DATE, allowNull: true },
    next_retry_at: { type: DataTypes.DATE, allowNull: true },
    failure_classification: { type: DataTypes.STRING(40), allowNull: true },
    dead_letter_reason: { type: DataTypes.STRING(1000), allowNull: true },
    last_error: { type: DataTypes.STRING(2000), allowNull: true },
    dead_lettered_at: { type: DataTypes.DATE, allowNull: true },
    queued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    duration_ms: { type: DataTypes.INTEGER, allowNull: true },
    payload: { type: DataTypes.JSONB, allowNull: true },
    result: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'ai_processing_jobs', timestamps: false }
);

const InspectionEvent = sequelize.define(
  'InspectionEvent',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    inspection_id: { type: DataTypes.UUID, allowNull: false },
    toilet_id: { type: DataTypes.UUID, allowNull: true },
    image_id: { type: DataTypes.UUID, allowNull: true },
    event_type: { type: DataTypes.STRING(120), allowNull: false },
    event_status: { type: DataTypes.STRING(60), allowNull: true },
    source: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'system' },
    actor_user_id: { type: DataTypes.UUID, allowNull: true },
    payload: { type: DataTypes.JSONB, allowNull: true },
    occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...commonTimestamps,
  },
  { tableName: 'inspection_events', timestamps: false }
);

const IdempotencyKey = sequelize.define(
  'IdempotencyKey',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    scope: { type: DataTypes.STRING(140), allowNull: false },
    idempotency_key: { type: DataTypes.STRING(220), allowNull: false },
    request_hash: { type: DataTypes.STRING(200), allowNull: true },
    response_code: { type: DataTypes.INTEGER, allowNull: true },
    response_body: { type: DataTypes.JSONB, allowNull: true },
    locked_until: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'idempotency_keys', timestamps: false }
);

const ToiletScoreDaily = sequelize.define(
  'ToiletScoreDaily',
  {
    id: defineUuidId(),
    toilet_id: { type: DataTypes.UUID, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    avg_before_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    avg_after_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    inspection_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    dirty_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cleaned_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    avg_improvement: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'toilet_score_daily', timestamps: false }
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
    client_reading_id: { type: DataTypes.STRING(120), allowNull: true },
    timestamp: { type: DataTypes.DATE, allowNull: false },
    recorded_at_utc: { type: DataTypes.DATE, allowNull: true },
    source_timezone: { type: DataTypes.STRING(64), allowNull: true },
    source_offset_minutes: { type: DataTypes.INTEGER, allowNull: true },
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
    source_channel: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'field_app' },
    reporter_name: { type: DataTypes.STRING(180), allowNull: true },
    reporter_contact: { type: DataTypes.STRING(120), allowNull: true },
    complaint_type: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(1000), allowNull: false },
    evidence_image_url: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM('open', 'assigned', 'resolved', 'rejected'), allowNull: false, defaultValue: 'open' },
    assigned_to_user_id: { type: DataTypes.UUID, allowNull: true },
    priority: { type: DataTypes.ENUM('low', 'medium', 'high', 'critical'), allowNull: false, defaultValue: 'medium' },
    dispatch_requested_at: { type: DataTypes.DATE, allowNull: true },
    dispatch_requested_by_user_id: { type: DataTypes.UUID, allowNull: true },
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
    notification_type: { type: DataTypes.STRING(80), allowNull: true },
    priority: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'MEDIUM' },
    title: { type: DataTypes.STRING(200), allowNull: true },
    body: { type: DataTypes.STRING(1200), allowNull: true },
    short_body: { type: DataTypes.STRING(280), allowNull: true },
    entity_type: { type: DataTypes.STRING(120), allowNull: true },
    entity_id: { type: DataTypes.STRING(120), allowNull: true },
    route: { type: DataTypes.STRING(320), allowNull: true },
    icon_key: { type: DataTypes.STRING(80), allowNull: true },
    severity: { type: DataTypes.STRING(20), allowNull: true },
    created_by_user_id: { type: DataTypes.UUID, allowNull: true },
    geography_id: { type: DataTypes.UUID, allowNull: true },
    facility_id: { type: DataTypes.UUID, allowNull: true },
    audience_kind: { type: DataTypes.STRING(40), allowNull: true },
    payload: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.ENUM('queued', 'sent', 'failed'), allowNull: false, defaultValue: 'queued' },
    delivery_state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING' },
    read_at: { type: DataTypes.DATE, allowNull: true },
    dismissed_at: { type: DataTypes.DATE, allowNull: true },
    dedupe_key: { type: DataTypes.STRING(220), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    sent_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'notification_events', timestamps: false }
);

const NotificationPreference = sequelize.define(
  'NotificationPreference',
  {
    id: defineUuidId(),
    user_id: { type: DataTypes.UUID, allowNull: false },
    notification_type: { type: DataTypes.STRING(80), allowNull: false },
    in_app_web_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    in_app_mobile_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    push_mobile_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    push_web_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    email_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sms_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...commonTimestamps,
  },
  { tableName: 'notification_preferences', timestamps: false }
);

const NotificationDeviceToken = sequelize.define(
  'NotificationDeviceToken',
  {
    id: defineUuidId(),
    user_id: { type: DataTypes.UUID, allowNull: false },
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    platform: { type: DataTypes.STRING(20), allowNull: false },
    token: { type: DataTypes.STRING(600), allowNull: false },
    device_id: { type: DataTypes.STRING(180), allowNull: true },
    app_version: { type: DataTypes.STRING(80), allowNull: true },
    locale: { type: DataTypes.STRING(32), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    last_active_at: { type: DataTypes.DATE, allowNull: true },
    disabled_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'notification_device_tokens', timestamps: false }
);

const NotificationDeliveryLog = sequelize.define(
  'NotificationDeliveryLog',
  {
    id: defineUuidId(),
    notification_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: true },
    channel: { type: DataTypes.STRING(60), allowNull: false },
    provider: { type: DataTypes.STRING(80), allowNull: true },
    provider_message_id: { type: DataTypes.STRING(220), allowNull: true },
    device_token_id: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING' },
    error_code: { type: DataTypes.STRING(120), allowNull: true },
    error_message: { type: DataTypes.STRING(2000), allowNull: true },
    attempted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    delivered_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'notification_delivery_logs', timestamps: false }
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

const AiUsageLog = sequelize.define(
  'AiUsageLog',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    user_id: { type: DataTypes.UUID, allowNull: true },
    worker_id: { type: DataTypes.UUID, allowNull: true },
    inspection_id: { type: DataTypes.UUID, allowNull: true },
    toilet_id: { type: DataTypes.UUID, allowNull: true },
    user_role: { type: DataTypes.STRING(80), allowNull: true },
    feature_key: { type: DataTypes.STRING(120), allowNull: false },
    feature_name: { type: DataTypes.STRING(200), allowNull: false },
    ai_provider: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'openai' },
    model_name: { type: DataTypes.STRING(120), allowNull: false },
    input_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    output_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    image_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    video_frame_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cost_usd: { type: DataTypes.DECIMAL(12, 8), allowNull: false, defaultValue: 0 },
    cost_inr: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0 },
    usd_to_inr_rate: { type: DataTypes.DECIMAL(8, 4), allowNull: false, defaultValue: 84.0 },
    is_estimated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: {
      type: DataTypes.ENUM('success', 'failed', 'partial'),
      allowNull: false,
      defaultValue: 'success',
    },
    latency_ms: { type: DataTypes.INTEGER, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    provider_request_id: { type: DataTypes.STRING(200), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'ai_usage_logs', timestamps: false }
);

const TenantLimit = sequelize.define(
  'TenantLimit',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false, unique: true },
    limits_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Storage
    storage_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    storage_limit_bytes: { type: DataTypes.BIGINT, allowNull: true },
    storage_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // AI tokens
    ai_token_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ai_token_limit: { type: DataTypes.BIGINT, allowNull: true },
    ai_token_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // AI requests
    ai_request_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ai_request_limit: { type: DataTypes.INTEGER, allowNull: true },
    ai_request_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Users
    user_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    user_limit: { type: DataTypes.INTEGER, allowNull: true },
    user_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Toilets
    toilet_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    toilet_limit: { type: DataTypes.INTEGER, allowNull: true },
    toilet_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Facilities
    facility_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    facility_limit: { type: DataTypes.INTEGER, allowNull: true },
    facility_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Devices
    device_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    device_limit: { type: DataTypes.INTEGER, allowNull: true },
    device_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Inspections
    inspection_limit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    inspection_limit: { type: DataTypes.INTEGER, allowNull: true },
    inspection_hard_block: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Notification flags
    quota_warning_75_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    quota_warning_90_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    quota_exhausted_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notify_tenant_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notify_super_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'tenant_limits', timestamps: false }
);

const TenantUsageSnapshot = sequelize.define(
  'TenantUsageSnapshot',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    calculated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    storage_used_bytes: { type: DataTypes.BIGINT, allowNull: true },
    storage_object_count: { type: DataTypes.BIGINT, allowNull: true },
    image_count: { type: DataTypes.INTEGER, allowNull: true },
    average_image_size_bytes: { type: DataTypes.BIGINT, allowNull: true },
    largest_file_bytes: { type: DataTypes.BIGINT, allowNull: true },
    latest_upload_at: { type: DataTypes.DATE, allowNull: true },
    ai_requests_30d: { type: DataTypes.INTEGER, allowNull: true },
    ai_tokens_30d: { type: DataTypes.BIGINT, allowNull: true },
    ai_cost_usd_30d: { type: DataTypes.DECIMAL(12, 6), allowNull: true },
    ai_failed_30d: { type: DataTypes.INTEGER, allowNull: true },
    users_count: { type: DataTypes.INTEGER, allowNull: true },
    active_users_count: { type: DataTypes.INTEGER, allowNull: true },
    workers_count: { type: DataTypes.INTEGER, allowNull: true },
    toilets_count: { type: DataTypes.INTEGER, allowNull: true },
    facilities_count: { type: DataTypes.INTEGER, allowNull: true },
    devices_count: { type: DataTypes.INTEGER, allowNull: true },
    inspections_count: { type: DataTypes.INTEGER, allowNull: true },
    inspections_30d: { type: DataTypes.INTEGER, allowNull: true },
    open_alerts_count: { type: DataTypes.INTEGER, allowNull: true },
    failed_uploads_count: { type: DataTypes.INTEGER, allowNull: true },
    source: {
      type: DataTypes.ENUM('db_metadata', 's3_scan', 'mixed'),
      allowNull: false,
      defaultValue: 'db_metadata',
    },
    status: {
      type: DataTypes.ENUM('fresh', 'stale', 'failed'),
      allowNull: false,
      defaultValue: 'fresh',
    },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'tenant_usage_snapshots', timestamps: false }
);

const TenantQuotaNotification = sequelize.define(
  'TenantQuotaNotification',
  {
    id: defineUuidId(),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    resource: { type: DataTypes.STRING(60), allowNull: false },
    threshold: { type: DataTypes.INTEGER, allowNull: false },
    usage_percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    limit_value: { type: DataTypes.BIGINT, allowNull: true },
    used_value: { type: DataTypes.BIGINT, allowNull: true },
    notification_sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    recipients: { type: DataTypes.JSONB, allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'sent' },
    reset_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'tenant_quota_notifications', timestamps: false }
);

const ApiProject = sequelize.define(
  'ApiProject',
  {
    id: defineUuidId(),
    project_name: { type: DataTypes.STRING(220), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    client_name: { type: DataTypes.STRING(220), allowNull: true },
    usage_by: { type: DataTypes.STRING(220), allowNull: true },
    project_owner_name: { type: DataTypes.STRING(180), allowNull: true },
    project_owner_email: { type: DataTypes.STRING(180), allowNull: true },
    project_owner_mobile: { type: DataTypes.STRING(32), allowNull: true },
    environment: { type: DataTypes.ENUM('sandbox', 'production'), allowNull: false, defaultValue: 'sandbox' },
    status: { type: DataTypes.ENUM('active', 'inactive', 'suspended'), allowNull: false, defaultValue: 'active' },
    allowed_tenant_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    created_by_super_admin_id: { type: DataTypes.UUID, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'api_projects', timestamps: false }
);

const ApiKey = sequelize.define(
  'ApiKey',
  {
    id: defineUuidId(),
    api_project_id: { type: DataTypes.UUID, allowNull: false },
    key_name: { type: DataTypes.STRING(180), allowNull: false },
    key_prefix: { type: DataTypes.STRING(32), allowNull: false, unique: true },
    api_key_hash: { type: DataTypes.STRING(128), allowNull: false, unique: true },
    environment: { type: DataTypes.ENUM('sandbox', 'production'), allowNull: false, defaultValue: 'sandbox' },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'revoked', 'expired'),
      allowNull: false,
      defaultValue: 'active',
    },
    permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    allowed_endpoints: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    allowed_tenant_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    allowed_origins: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    allowed_ips: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    rate_limit_per_minute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    rate_limit_per_day: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1000 },
    monthly_quota: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30000 },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    last_used_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    revoked_by: { type: DataTypes.UUID, allowNull: true },
    revoke_reason: { type: DataTypes.TEXT, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'api_keys', timestamps: false }
);

const ApiUsageLog = sequelize.define(
  'ApiUsageLog',
  {
    id: defineUuidId(),
    api_project_id: { type: DataTypes.UUID, allowNull: true },
    api_key_id: { type: DataTypes.UUID, allowNull: true },
    endpoint: { type: DataTypes.STRING(240), allowNull: false },
    method: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'GET' },
    request_ip: { type: DataTypes.STRING(80), allowNull: true },
    user_agent: { type: DataTypes.STRING(500), allowNull: true },
    lat_rounded: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    lng_rounded: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    radius: { type: DataTypes.INTEGER, allowNull: true },
    response_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status_code: { type: DataTypes.INTEGER, allowNull: false },
    error_code: { type: DataTypes.STRING(120), allowNull: true },
    error_message: { type: DataTypes.STRING(1000), allowNull: true },
    response_time_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'api_usage_logs', timestamps: false }
);

const ApiUsageDailySummary = sequelize.define(
  'ApiUsageDailySummary',
  {
    id: defineUuidId(),
    api_project_id: { type: DataTypes.UUID, allowNull: false },
    api_key_id: { type: DataTypes.UUID, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    total_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    successful_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rate_limited_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    avg_response_time_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    p95_response_time_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_toilets_returned: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unique_ips_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...commonTimestamps,
  },
  { tableName: 'api_usage_daily_summary', timestamps: false }
);

const ApiKeyEvent = sequelize.define(
  'ApiKeyEvent',
  {
    id: defineUuidId(),
    api_project_id: { type: DataTypes.UUID, allowNull: true },
    api_key_id: { type: DataTypes.UUID, allowNull: true },
    event_type: { type: DataTypes.STRING(120), allowNull: false },
    actor_user_id: { type: DataTypes.UUID, allowNull: true },
    request_ip: { type: DataTypes.STRING(80), allowNull: true },
    user_agent: { type: DataTypes.STRING(500), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'api_key_events', timestamps: false }
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

const BackupSchedule = sequelize.define(
  'BackupSchedule',
  {
    id: defineUuidId(),
    scope: { type: DataTypes.STRING(20), allowNull: false },
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    frequency: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'daily' },
    cron_expression: { type: DataTypes.STRING(120), allowNull: true },
    timezone: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'Asia/Kolkata' },
    run_time: { type: DataTypes.TIME, allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    retention_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
    include_storage_metadata: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    include_storage_files: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    last_run_at: { type: DataTypes.DATE, allowNull: true },
    next_run_at: { type: DataTypes.DATE, allowNull: true },
    ...commonTimestamps,
  },
  { tableName: 'backup_schedules', timestamps: false }
);

const BackupJob = sequelize.define(
  'BackupJob',
  {
    id: defineUuidId(),
    schedule_id: { type: DataTypes.UUID, allowNull: true },
    scope: { type: DataTypes.STRING(20), allowNull: false },
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
    triggered_by: { type: DataTypes.STRING(20), allowNull: false },
    requested_by: { type: DataTypes.UUID, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    duration_ms: { type: DataTypes.INTEGER, allowNull: true },
    file_path: { type: DataTypes.STRING(700), allowNull: true },
    file_name: { type: DataTypes.STRING(260), allowNull: true },
    file_size_bytes: { type: DataTypes.BIGINT, allowNull: true },
    checksum_sha256: { type: DataTypes.STRING(128), allowNull: true },
    error_message: { type: DataTypes.STRING(2000), allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'backup_jobs', timestamps: false }
);

const BackupFile = sequelize.define(
  'BackupFile',
  {
    id: defineUuidId(),
    backup_job_id: { type: DataTypes.UUID, allowNull: false },
    storage_provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'local' },
    bucket_name: { type: DataTypes.STRING(180), allowNull: true },
    file_path: { type: DataTypes.STRING(700), allowNull: false },
    file_name: { type: DataTypes.STRING(260), allowNull: false },
    size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    checksum_sha256: { type: DataTypes.STRING(128), allowNull: true },
    content_type: { type: DataTypes.STRING(120), allowNull: false, defaultValue: 'application/zip' },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'backup_files', timestamps: false }
);

const BackupAuditLog = sequelize.define(
  'BackupAuditLog',
  {
    id: defineUuidId(),
    action: { type: DataTypes.STRING(120), allowNull: false },
    actor_user_id: { type: DataTypes.UUID, allowNull: true },
    backup_job_id: { type: DataTypes.UUID, allowNull: true },
    backup_schedule_id: { type: DataTypes.UUID, allowNull: true },
    scope: { type: DataTypes.STRING(20), allowNull: true },
    tenant_id: { type: DataTypes.UUID, allowNull: true },
    ip_address: { type: DataTypes.STRING(80), allowNull: true },
    user_agent: { type: DataTypes.STRING(500), allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'backup_audit_logs', timestamps: false }
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
Tenant.belongsTo(Geography, { foreignKey: 'root_geography_id', as: 'rootGeography' });
Geography.hasMany(Tenant, { foreignKey: 'root_geography_id', as: 'scopedTenants' });
Tenant.hasMany(Facility, { foreignKey: 'tenant_id' });
Facility.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Facility.belongsTo(Geography, { foreignKey: 'geography_id' });
Geography.hasMany(Facility, { foreignKey: 'geography_id' });
Facility.belongsTo(Geography, { foreignKey: 'zone_geography_id', as: 'zone' });
Geography.hasMany(Facility, { foreignKey: 'zone_geography_id', as: 'zoneFacilities' });
Facility.belongsTo(Geography, { foreignKey: 'ward_geography_id', as: 'ward' });
Geography.hasMany(Facility, { foreignKey: 'ward_geography_id', as: 'wardFacilities' });
Facility.belongsTo(PlatformUser, { foreignKey: 'supervisor_user_id', as: 'supervisor' });
PlatformUser.hasMany(Facility, { foreignKey: 'supervisor_user_id', as: 'supervisedFacilities' });

Facility.hasMany(ToiletBlock, { foreignKey: 'facility_id' });
ToiletBlock.belongsTo(Facility, { foreignKey: 'facility_id' });
Facility.hasMany(ToiletUnit, { foreignKey: 'facility_id' });
ToiletUnit.belongsTo(Facility, { foreignKey: 'facility_id' });
ToiletBlock.hasMany(ToiletUnit, { foreignKey: 'toilet_block_id' });
ToiletUnit.belongsTo(ToiletBlock, { foreignKey: 'toilet_block_id' });
Tenant.hasMany(ToiletQrCode, { foreignKey: 'tenant_id', as: 'toiletQrCodes' });
ToiletQrCode.belongsTo(Tenant, { foreignKey: 'tenant_id' });
ToiletUnit.hasMany(ToiletQrCode, { foreignKey: 'toilet_unit_id', as: 'qrCodes' });
ToiletQrCode.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id', as: 'toiletUnit' });
PlatformUser.hasMany(ToiletQrCode, { foreignKey: 'created_by_user_id', as: 'createdToiletQrCodes' });
ToiletQrCode.belongsTo(PlatformUser, { foreignKey: 'created_by_user_id', as: 'createdBy' });
PlatformUser.hasMany(ToiletQrCode, { foreignKey: 'updated_by_user_id', as: 'updatedToiletQrCodes' });
ToiletQrCode.belongsTo(PlatformUser, { foreignKey: 'updated_by_user_id', as: 'updatedBy' });

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
PlatformUser.hasMany(WorkerAssignment, { foreignKey: 'supervisor_user_id', as: 'supervisedAssignments' });
WorkerAssignment.belongsTo(PlatformUser, { foreignKey: 'supervisor_user_id', as: 'supervisor' });
PlatformUser.hasMany(WorkerAssignment, { foreignKey: 'created_by_user_id', as: 'createdAssignments' });
WorkerAssignment.belongsTo(PlatformUser, { foreignKey: 'created_by_user_id', as: 'createdBy' });
PlatformUser.hasMany(WorkerAssignment, { foreignKey: 'updated_by_user_id', as: 'updatedAssignments' });
WorkerAssignment.belongsTo(PlatformUser, { foreignKey: 'updated_by_user_id', as: 'updatedBy' });

InspectionTask.belongsTo(PlatformUser, { foreignKey: 'assigned_to_user_id', as: 'assignee' });
InspectionTask.belongsTo(PlatformUser, { foreignKey: 'assigned_by_user_id', as: 'assignedBy' });
InspectionTask.belongsTo(Facility, { foreignKey: 'facility_id' });
InspectionTask.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
InspectionTask.belongsTo(Complaint, { foreignKey: 'complaint_id', as: 'complaint' });
Complaint.hasMany(InspectionTask, { foreignKey: 'complaint_id', as: 'tasks' });
Inspection.belongsTo(InspectionTask, { foreignKey: 'task_id' });
Inspection.belongsTo(Facility, { foreignKey: 'facility_id' });
Inspection.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
Inspection.belongsTo(PlatformUser, { foreignKey: 'inspector_user_id', as: 'inspector' });
Inspection.belongsTo(WorkerAssignment, { foreignKey: 'assignment_id', as: 'assignment' });
WorkerAssignment.hasMany(Inspection, { foreignKey: 'assignment_id', as: 'inspections' });
Inspection.hasMany(InspectionMedia, { foreignKey: 'inspection_id' });
InspectionMedia.belongsTo(Inspection, { foreignKey: 'inspection_id' });
ToiletUnit.hasMany(InspectionMedia, { foreignKey: 'toilet_unit_id', as: 'inspectionMedia' });
InspectionMedia.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id' });
PlatformUser.hasMany(InspectionMedia, { foreignKey: 'worker_id', as: 'inspectionMedia' });
InspectionMedia.belongsTo(PlatformUser, { foreignKey: 'worker_id', as: 'worker' });
WorkerAssignment.hasMany(InspectionMedia, { foreignKey: 'assignment_id', as: 'inspectionMedia' });
InspectionMedia.belongsTo(WorkerAssignment, { foreignKey: 'assignment_id', as: 'assignment' });
Inspection.hasMany(AiAnalysisResult, { foreignKey: 'inspection_id' });
AiAnalysisResult.belongsTo(Inspection, { foreignKey: 'inspection_id' });
Inspection.hasMany(ImageSession, { foreignKey: 'inspection_id', as: 'imageSessions' });
ImageSession.belongsTo(Inspection, { foreignKey: 'inspection_id' });
ImageSession.belongsTo(InspectionMedia, { foreignKey: 'media_id', as: 'media' });
InspectionMedia.hasMany(ImageSession, { foreignKey: 'media_id', as: 'sessions' });
Inspection.hasMany(InspectionSubmission, {
  foreignKey: 'inspection_id',
  as: 'inspectionSubmissions',
});
InspectionSubmission.belongsTo(Inspection, { foreignKey: 'inspection_id' });
InspectionSubmission.hasMany(AiProcessingJob, {
  foreignKey: 'submission_id',
  as: 'processingJobs',
});
AiProcessingJob.belongsTo(InspectionSubmission, { foreignKey: 'submission_id', as: 'submission' });
Inspection.hasMany(AiProcessingJob, { foreignKey: 'inspection_id', as: 'processingJobs' });
AiProcessingJob.belongsTo(Inspection, { foreignKey: 'inspection_id' });
InspectionMedia.hasMany(AiProcessingJob, { foreignKey: 'image_id', as: 'processingJobs' });
AiProcessingJob.belongsTo(InspectionMedia, { foreignKey: 'image_id', as: 'image' });
Inspection.hasMany(InspectionEvent, { foreignKey: 'inspection_id', as: 'events' });
InspectionEvent.belongsTo(Inspection, { foreignKey: 'inspection_id' });
ToiletUnit.hasMany(InspectionEvent, { foreignKey: 'toilet_id', as: 'events' });
InspectionEvent.belongsTo(ToiletUnit, { foreignKey: 'toilet_id', as: 'toilet' });
InspectionMedia.hasMany(InspectionEvent, { foreignKey: 'image_id', as: 'events' });
InspectionEvent.belongsTo(InspectionMedia, { foreignKey: 'image_id', as: 'image' });
PlatformUser.hasMany(InspectionEvent, { foreignKey: 'actor_user_id', as: 'inspectionEvents' });
InspectionEvent.belongsTo(PlatformUser, { foreignKey: 'actor_user_id', as: 'actor' });
Tenant.hasMany(ImageSession, { foreignKey: 'tenant_id' });
ImageSession.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Tenant.hasMany(InspectionSubmission, { foreignKey: 'tenant_id' });
InspectionSubmission.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Tenant.hasMany(AiProcessingJob, { foreignKey: 'tenant_id' });
AiProcessingJob.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Tenant.hasMany(InspectionEvent, { foreignKey: 'tenant_id' });
InspectionEvent.belongsTo(Tenant, { foreignKey: 'tenant_id' });
Tenant.hasMany(IdempotencyKey, { foreignKey: 'tenant_id' });
IdempotencyKey.belongsTo(Tenant, { foreignKey: 'tenant_id' });
ToiletUnit.hasMany(ToiletScoreDaily, { foreignKey: 'toilet_id', as: 'dailyScores' });
ToiletScoreDaily.belongsTo(ToiletUnit, { foreignKey: 'toilet_id' });

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
Complaint.belongsTo(PlatformUser, {
  foreignKey: 'dispatch_requested_by_user_id',
  as: 'dispatchRequestedBy',
});
PlatformUser.hasMany(NotificationEvent, { foreignKey: 'user_id', as: 'notifications' });
NotificationEvent.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });
Tenant.hasMany(NotificationEvent, { foreignKey: 'tenant_id', as: 'notificationEvents' });
NotificationEvent.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
PlatformUser.hasMany(NotificationEvent, { foreignKey: 'created_by_user_id', as: 'createdNotifications' });
NotificationEvent.belongsTo(PlatformUser, { foreignKey: 'created_by_user_id', as: 'createdByUser' });
Geography.hasMany(NotificationEvent, { foreignKey: 'geography_id', as: 'notificationEvents' });
NotificationEvent.belongsTo(Geography, { foreignKey: 'geography_id', as: 'geography' });
Facility.hasMany(NotificationEvent, { foreignKey: 'facility_id', as: 'notificationEvents' });
NotificationEvent.belongsTo(Facility, { foreignKey: 'facility_id', as: 'facility' });

PlatformUser.hasMany(NotificationPreference, { foreignKey: 'user_id', as: 'notificationPreferences' });
NotificationPreference.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });

PlatformUser.hasMany(NotificationDeviceToken, { foreignKey: 'user_id', as: 'notificationDeviceTokens' });
NotificationDeviceToken.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });
Tenant.hasMany(NotificationDeviceToken, { foreignKey: 'tenant_id', as: 'notificationDeviceTokens' });
NotificationDeviceToken.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });

NotificationEvent.hasMany(NotificationDeliveryLog, {
  foreignKey: 'notification_id',
  as: 'deliveryLogs',
});
NotificationDeliveryLog.belongsTo(NotificationEvent, {
  foreignKey: 'notification_id',
  as: 'notification',
});
PlatformUser.hasMany(NotificationDeliveryLog, { foreignKey: 'user_id', as: 'notificationDeliveryLogs' });
NotificationDeliveryLog.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });
NotificationDeviceToken.hasMany(NotificationDeliveryLog, {
  foreignKey: 'device_token_id',
  as: 'deliveryLogs',
});
NotificationDeliveryLog.belongsTo(NotificationDeviceToken, {
  foreignKey: 'device_token_id',
  as: 'deviceToken',
});
WorkerHeartbeat.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(WorkerHeartbeat, { foreignKey: 'tenant_id', as: 'workerHeartbeats' });
WorkerHeartbeat.belongsTo(PlatformUser, { foreignKey: 'worker_id', as: 'worker' });
PlatformUser.hasMany(WorkerHeartbeat, { foreignKey: 'worker_id', as: 'heartbeats' });

TaskAssignmentLog.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(TaskAssignmentLog, { foreignKey: 'tenant_id', as: 'taskAssignmentLogs' });
TaskAssignmentLog.belongsTo(InspectionTask, { foreignKey: 'task_id', as: 'task' });
InspectionTask.hasMany(TaskAssignmentLog, { foreignKey: 'task_id', as: 'assignmentLogs' });
TaskAssignmentLog.belongsTo(Complaint, { foreignKey: 'complaint_id', as: 'complaint' });
Complaint.hasMany(TaskAssignmentLog, { foreignKey: 'complaint_id', as: 'assignmentLogs' });
TaskAssignmentLog.belongsTo(ToiletUnit, { foreignKey: 'toilet_unit_id', as: 'toiletUnit' });
TaskAssignmentLog.belongsTo(PlatformUser, { foreignKey: 'worker_id', as: 'worker' });
TaskAssignmentLog.belongsTo(PlatformUser, { foreignKey: 'supervisor_user_id', as: 'supervisor' });
TaskAssignmentLog.belongsTo(PlatformUser, { foreignKey: 'assigned_by_user_id', as: 'assignedBy' });

TaskReminderLog.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(TaskReminderLog, { foreignKey: 'tenant_id', as: 'taskReminderLogs' });
TaskReminderLog.belongsTo(InspectionTask, { foreignKey: 'task_id', as: 'task' });
InspectionTask.hasMany(TaskReminderLog, { foreignKey: 'task_id', as: 'reminderLogs' });
TaskReminderLog.belongsTo(PlatformUser, { foreignKey: 'worker_id', as: 'worker' });
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
BackupSchedule.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(BackupSchedule, { foreignKey: 'tenant_id', as: 'backupSchedules' });
BackupSchedule.belongsTo(PlatformUser, { foreignKey: 'created_by', as: 'createdBy' });
BackupSchedule.belongsTo(PlatformUser, { foreignKey: 'updated_by', as: 'updatedBy' });
BackupJob.belongsTo(BackupSchedule, { foreignKey: 'schedule_id', as: 'schedule' });
BackupSchedule.hasMany(BackupJob, { foreignKey: 'schedule_id', as: 'jobs' });
BackupJob.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(BackupJob, { foreignKey: 'tenant_id', as: 'backupJobs' });
BackupJob.belongsTo(PlatformUser, { foreignKey: 'requested_by', as: 'requestedBy' });
BackupFile.belongsTo(BackupJob, { foreignKey: 'backup_job_id', as: 'job' });
BackupJob.hasMany(BackupFile, { foreignKey: 'backup_job_id', as: 'files' });
BackupAuditLog.belongsTo(BackupJob, { foreignKey: 'backup_job_id', as: 'job' });
BackupJob.hasMany(BackupAuditLog, { foreignKey: 'backup_job_id', as: 'auditLogs' });
BackupAuditLog.belongsTo(BackupSchedule, { foreignKey: 'backup_schedule_id', as: 'schedule' });
BackupSchedule.hasMany(BackupAuditLog, { foreignKey: 'backup_schedule_id', as: 'auditLogs' });
BackupAuditLog.belongsTo(PlatformUser, { foreignKey: 'actor_user_id', as: 'actor' });
BackupAuditLog.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
SuperAdminSyncFailure.belongsTo(Tenant, { foreignKey: 'tenant_id' });
SuperAdminTenantHealth.belongsTo(Tenant, { foreignKey: 'tenant_id' });

AiUsageLog.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(AiUsageLog, { foreignKey: 'tenant_id', as: 'aiUsageLogs' });
AiUsageLog.belongsTo(PlatformUser, { foreignKey: 'user_id', as: 'user' });
AiUsageLog.belongsTo(PlatformUser, { foreignKey: 'worker_id', as: 'worker' });
AiUsageLog.belongsTo(Inspection, { foreignKey: 'inspection_id', as: 'inspection' });
AiUsageLog.belongsTo(ToiletUnit, { foreignKey: 'toilet_id', as: 'toilet' });

TenantLimit.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasOne(TenantLimit, { foreignKey: 'tenant_id', as: 'limits' });

TenantUsageSnapshot.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(TenantUsageSnapshot, { foreignKey: 'tenant_id', as: 'usageSnapshots' });

TenantQuotaNotification.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(TenantQuotaNotification, { foreignKey: 'tenant_id', as: 'quotaNotifications' });

ApiProject.belongsTo(PlatformUser, { foreignKey: 'created_by_super_admin_id', as: 'createdBySuperAdmin' });
PlatformUser.hasMany(ApiProject, { foreignKey: 'created_by_super_admin_id', as: 'createdApiProjects' });
ApiProject.hasMany(ApiKey, { foreignKey: 'api_project_id', as: 'apiKeys' });
ApiKey.belongsTo(ApiProject, { foreignKey: 'api_project_id', as: 'project' });
ApiKey.belongsTo(PlatformUser, { foreignKey: 'created_by', as: 'createdBy' });
ApiKey.belongsTo(PlatformUser, { foreignKey: 'revoked_by', as: 'revokedBy' });
ApiProject.hasMany(ApiUsageLog, { foreignKey: 'api_project_id', as: 'usageLogs' });
ApiKey.hasMany(ApiUsageLog, { foreignKey: 'api_key_id', as: 'usageLogs' });
ApiUsageLog.belongsTo(ApiProject, { foreignKey: 'api_project_id', as: 'project' });
ApiUsageLog.belongsTo(ApiKey, { foreignKey: 'api_key_id', as: 'apiKey' });
ApiProject.hasMany(ApiUsageDailySummary, { foreignKey: 'api_project_id', as: 'dailySummaries' });
ApiKey.hasMany(ApiUsageDailySummary, { foreignKey: 'api_key_id', as: 'dailySummaries' });
ApiUsageDailySummary.belongsTo(ApiProject, { foreignKey: 'api_project_id', as: 'project' });
ApiUsageDailySummary.belongsTo(ApiKey, { foreignKey: 'api_key_id', as: 'apiKey' });
ApiProject.hasMany(ApiKeyEvent, { foreignKey: 'api_project_id', as: 'keyEvents' });
ApiKey.hasMany(ApiKeyEvent, { foreignKey: 'api_key_id', as: 'events' });
ApiKeyEvent.belongsTo(ApiProject, { foreignKey: 'api_project_id', as: 'project' });
ApiKeyEvent.belongsTo(ApiKey, { foreignKey: 'api_key_id', as: 'apiKey' });
ApiKeyEvent.belongsTo(PlatformUser, { foreignKey: 'actor_user_id', as: 'actor' });

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
  ToiletQrCode,
  InspectionTask,
  WorkerHeartbeat,
  TaskAssignmentLog,
  TaskReminderLog,
  Inspection,
  InspectionMedia,
  AiAnalysisResult,
  ImageSession,
  InspectionSubmission,
  AiProcessingJob,
  InspectionEvent,
  IdempotencyKey,
  ToiletScoreDaily,
  SensorDevice,
  SensorReading,
  Alert,
  CleaningEvent,
  Complaint,
  NotificationEvent,
  NotificationPreference,
  NotificationDeviceToken,
  NotificationDeliveryLog,
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
  BackupSchedule,
  BackupJob,
  BackupFile,
  BackupAuditLog,
  SuperAdminSyncFailure,
  SuperAdminTenantHealth,
  PasswordResetToken,
  AiUsageLog,
  TenantLimit,
  TenantUsageSnapshot,
  TenantQuotaNotification,
  ApiProject,
  ApiKey,
  ApiUsageLog,
  ApiUsageDailySummary,
  ApiKeyEvent,
};
