const bcrypt = require('bcrypt');
const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize,
  Tenant,
  Geography,
  PlatformUser,
  UserRole,
  Facility,
  Inspection,
  AiAnalysisResult,
  SensorDevice,
  SensorReading,
  InspectionTask,
  Complaint,
  Alert,
  NotificationEvent,
  AuditLog,
  Role,
  Permission,
  IntegrationConfig,
  StorageUsageMetric,
  DashboardAggregate,
  SuperAdminProject,
  SuperAdminApproval,
  SuperAdminSupportTicket,
  SuperAdminReleaseRecord,
  SuperAdminBackupRecord,
  SuperAdminSyncFailure,
  SuperAdminTenantHealth,
} = require('../../models');
const AppError = require('../../core/errors/AppError');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const { createAuditLog, listAuditLogs: listAuditLogsService } = require('../audit/audit.service');
const { getQueueMetrics, isRedisEnabled } = require('../../core/queue/queueManager');
const { ANALYSIS_QUEUE } = require('../analysis/analysis.queue');
const { runtimeConfig } = require('../../config/runtime');
const { AI_SCORING_POLICY_VERSION, AI_SCORING_MODES, resolveAiScoringMode } = require('../analysis/aiInspectionScoring.service');

const TENANT_ADMIN_ROLE_CODES = ['tenant_admin', 'country_admin', 'state_admin', 'district_admin', 'city_admin', 'zone_admin'];
const TENANT_SCOPE_LEVELS = new Set(['country', 'state', 'district', 'city', 'zone']);
const TENANT_SCOPE_REQUIRED_FIELDS = {
  country: ['countryName'],
  state: ['countryName', 'stateName'],
  district: ['countryName', 'stateName', 'districtName'],
  city: ['countryName', 'stateName', 'cityName'],
  zone: ['countryName', 'stateName', 'cityName', 'zoneName'],
};

const ensureSuperAdmin = (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can access this endpoint', 403, { code: 'SUPER_ADMIN_ONLY' });
  }
};

const assertTenantScopeLocationRequirements = ({ scopeLevel, locationNames = {} }) => {
  const requiredFields = TENANT_SCOPE_REQUIRED_FIELDS[scopeLevel] || [];
  for (const field of requiredFields) {
    const value = String(locationNames[field] || '').trim();
    if (!value) {
      throw new AppError(
        `${field} is required for ${scopeLevel}-level tenant scope`,
        400,
        { code: 'TENANT_SCOPE_LOCATION_REQUIRED' }
      );
    }
  }
};

const resolveLimit = (value, fallback = 50, max = 500) => {
  const parsed = Number.parseInt(String(value || fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toNullableNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const mapGeographyTrailNode = (row) => ({
  id: row.id,
  parentId: row.parent_id || null,
  level: row.level,
  code: row.code,
  name: row.name,
  centroidLatitude: toNullableNumber(row.centroid_latitude),
  centroidLongitude: toNullableNumber(row.centroid_longitude),
  boundaryCenterLatitude: toNullableNumber(row.boundary_center_latitude),
  boundaryCenterLongitude: toNullableNumber(row.boundary_center_longitude),
});

const coordinatePairFromTrailNode = (node) => {
  if (!node) return null;
  const latitude = node.centroidLatitude ?? node.boundaryCenterLatitude ?? null;
  const longitude = node.centroidLongitude ?? node.boundaryCenterLongitude ?? null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
};

const buildGeographyTrail = (geographyRow, geographyById) => {
  const trail = [];
  const seen = new Set();
  let current = geographyRow;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.push(mapGeographyTrailNode(current));
    current = current.parent_id ? geographyById.get(current.parent_id) : null;
  }

  return trail.reverse();
};

const resolveTrailPoint = (trail) => {
  const reversedTrail = [...trail].reverse();
  for (const node of reversedTrail) {
    const point = coordinatePairFromTrailNode(node);
    if (point) {
      return {
        ...point,
        sourceLevel: node.level || null,
        sourceName: node.name || null,
        sourceId: node.id || null,
      };
    }
  }

  return {
    latitude: null,
    longitude: null,
    sourceLevel: null,
    sourceName: null,
    sourceId: null,
  };
};

const buildTenantLocationTrail = (tenant, geographyById) => {
  const rootGeography = tenant.root_geography_id ? geographyById.get(tenant.root_geography_id) : null;
  if (rootGeography) {
    return buildGeographyTrail(rootGeography, geographyById);
  }

  const tenantLocations = [
    ['country', tenant.country_code, tenant.country_name],
    ['state', null, tenant.state_name],
    ['district', null, tenant.district_name],
    ['city', null, tenant.city_name],
    ['zone', null, tenant.zone_name],
  ];

  return tenantLocations
    .filter(([, , name]) => Boolean(String(name || '').trim()))
    .map(([level, code, name], index, locations) => ({
      id: `${tenant.id}:${level}`,
      parentId: index > 0 ? `${tenant.id}:${locations[index - 1][0]}` : null,
      level,
      code: code || null,
      name,
      centroidLatitude: null,
      centroidLongitude: null,
      boundaryCenterLatitude: null,
      boundaryCenterLongitude: null,
    }));
};

const toMultiCityRollup = (tenant, geographyById, facilityCount = 0) => {
  const trail = buildTenantLocationTrail(tenant, geographyById);
  const trailByLevel = new Map(trail.map((node) => [String(node.level || '').toLowerCase(), node]));
  const mapPoint = resolveTrailPoint(trail);
  const country = trailByLevel.get('country') || null;
  const state = trailByLevel.get('state') || null;
  const district = trailByLevel.get('district') || null;
  const city = trailByLevel.get('city') || null;
  const zone = trailByLevel.get('zone') || null;
  const ward = trailByLevel.get('ward') || null;

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantCode: tenant.code,
    tenantStatus: tenant.status,
    geographyId: tenant.root_geography_id || null,
    scopeLevel: tenant.scope_level || 'city',
    locationName:
      tenant.zone_name ||
      tenant.city_name ||
      tenant.district_name ||
      tenant.state_name ||
      tenant.country_name ||
      tenant.name,
    addressLine: tenant.address_line || null,
    cityName: tenant.city_name || city?.name || null,
    cityCode: city?.code || null,
    countryId: country?.id || null,
    countryName: tenant.country_name || country?.name || null,
    countryCode: tenant.country_code || country?.code || null,
    stateId: state?.id || null,
    stateName: tenant.state_name || state?.name || null,
    districtId: district?.id || null,
    districtName: tenant.district_name || district?.name || null,
    zoneId: zone?.id || null,
    zoneName: tenant.zone_name || zone?.name || null,
    wardId: ward?.id || null,
    wardName: ward?.name || null,
    mapLatitude: mapPoint.latitude,
    mapLongitude: mapPoint.longitude,
    mapSourceLevel: mapPoint.sourceLevel,
    mapSourceName: mapPoint.sourceName,
    geocodeQuery: [
      tenant.address_line,
      tenant.zone_name,
      tenant.city_name,
      tenant.district_name,
      tenant.state_name,
      tenant.country_name,
    ]
      .filter(Boolean)
      .join(', '),
    facilityCount,
    hierarchy: trail,
  };
};

const mapConfigRow = (row) => ({
  id: row.id,
  name: row.name,
  configType: row.config_type,
  enabled: row.enabled,
  config: row.config_json,
  updatedAt: row.updated_at,
});

const getConfigs = (configType) =>
  IntegrationConfig.findAll({
    where: { tenant_id: null, config_type: configType },
    order: [['updated_at', 'DESC']],
  });

const upsertConfig = async ({ configType, name, config, enabled = true }) => {
  const existing = await IntegrationConfig.findOne({
    where: { tenant_id: null, config_type: configType, name },
  });
  if (existing) {
    await existing.update({ config_json: config, enabled, updated_at: new Date() });
    return existing;
  }
  return IntegrationConfig.create({
    tenant_id: null,
    config_type: configType,
    name,
    config_json: config,
    enabled,
  });
};

const getTenantMetadata = (tenant) => {
  if (!tenant?.metadata) {
    return {};
  }
  if (typeof tenant.metadata === 'string') {
    try {
      const parsed = JSON.parse(tenant.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    } catch (error) {
      return {};
    }
  }
  if (typeof tenant.metadata !== 'object' || Array.isArray(tenant.metadata)) {
    return {};
  }
  return tenant.metadata;
};

const mapTenant = (tenant, metrics = null) => {
  const metadata = getTenantMetadata(tenant);
  return {
    id: tenant.id,
    name: tenant.name,
    code: tenant.code,
    status: tenant.status,
    externalApiSharingEnabled: Boolean(tenant.external_api_sharing_enabled),
    aiScoringMode: resolveAiScoringMode(metadata.aiScoringMode || tenant.ai_scoring_mode),
    effectiveAiScoringMode: resolveAiScoringMode(metadata.aiScoringMode || tenant.ai_scoring_mode),
    aiScoringPolicyVersion: AI_SCORING_POLICY_VERSION,
    aiScoringUpdatedAt: metadata.aiScoringModeUpdatedAt || tenant.updated_at || null,
    aiScoringUpdatedBy: metadata.aiScoringModeUpdatedBy || null,
    countryCode: tenant.country_code,
    contactName: tenant.contact_name || null,
    contactEmail: tenant.contact_email || null,
    contactMobile: tenant.contact_mobile || null,
    scopeLevel: tenant.scope_level || 'city',
    countryName: tenant.country_name || null,
    stateName: tenant.state_name || null,
    districtName: tenant.district_name || null,
    cityName: tenant.city_name || null,
    zoneName: tenant.zone_name || null,
    addressLine: tenant.address_line || null,
    rootGeographyId: tenant.root_geography_id || null,
    plan: metadata.plan || null,
    metadata,
    createdAt: tenant.created_at,
    updatedAt: tenant.updated_at,
    metrics: metrics || undefined,
  };
};

const fetchTenantMetrics = async (tenantId, { transaction } = {}) => {
  const [facilities, activeUsers, totalUsers, openAlerts, inspections, sectors, sites] = await Promise.all([
    Facility.count({ where: { tenant_id: tenantId }, transaction }),
    PlatformUser.count({ where: { tenant_id: tenantId, status: 'active' }, transaction }),
    PlatformUser.count({ where: { tenant_id: tenantId }, transaction }),
    Alert.count({
      where: {
        tenant_id: tenantId,
        status: { [Op.in]: ['open', 'acknowledged'] },
      },
      transaction,
    }),
    Inspection.count({ where: { tenant_id: tenantId }, transaction }),
    Geography.count({
      where: {
        tenant_id: tenantId,
        level: { [Op.in]: ['zone', 'ward', 'cluster'] },
      },
      transaction,
    }),
    Facility.count({ where: { tenant_id: tenantId }, transaction }),
  ]);
  return {
    facilities,
    activeUsers,
    totalUsers,
    openAlerts,
    inspections,
    sectors,
    sites,
  };
};

const ensureRoleByCode = async (roleCode, { transaction } = {}) => {
  const role = await Role.findOne({
    where: { code: roleCode },
    transaction,
  });
  if (!role) {
    throw new AppError(`Role ${roleCode} is not configured`, 500, {
      code: 'ROLE_CONFIG_MISSING',
    });
  }
  return role;
};

const createTenantAdminUser = async ({ req, tenant, admin, transaction }) => {
  const role = await ensureRoleByCode('tenant_admin', { transaction });
  const email = String(admin.email).trim().toLowerCase();
  const fullName = sanitizeText(admin.fullName, 180);
  const phone = admin.phone ? sanitizeText(admin.phone, 32) : null;

  const existingUser = await PlatformUser.findOne({
    where: { email },
    transaction,
  });
  if (existingUser) {
    throw new AppError('Admin email already exists', 409, { code: 'EMAIL_EXISTS' });
  }

  const passwordHash = await bcrypt.hash(String(admin.password), 10);
  const createdUser = await PlatformUser.create(
    {
      tenant_id: tenant.id,
      geography_id: admin.geographyId || null,
      full_name: fullName,
      email,
      phone,
      employee_code: admin.employeeCode ? sanitizeText(admin.employeeCode, 64) : null,
      password_hash: passwordHash,
      auth_provider: 'local',
      status: admin.status || 'active',
      metadata: admin.metadata || null,
    },
    { transaction }
  );

  await UserRole.create(
    {
      user_id: createdUser.id,
      role_id: role.id,
      tenant_id: tenant.id,
      geography_id: admin.geographyId || null,
    },
    { transaction }
  );

  await createAuditLog({
    req,
    action: 'super_admin.tenant_admin_create',
    entityType: 'platform_user',
    entityId: createdUser.id,
    tenantId: tenant.id,
    details: {
      roleCode: 'tenant_admin',
      email: createdUser.email,
    },
  });

  return {
    id: createdUser.id,
    fullName: createdUser.full_name,
    email: createdUser.email,
    phone: createdUser.phone,
    status: createdUser.status,
    roleCode: 'tenant_admin',
  };
};

const getTenants = async (req) => {
  ensureSuperAdmin(req);
  const rows = await Tenant.findAll({ order: [['name', 'ASC']] });
  return rows.map((row) => mapTenant(row));
};

const getTenantById = async (req) => {
  ensureSuperAdmin(req);
  const tenant = await Tenant.findByPk(req.params.id);
  if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });

  const [metrics, adminRows] = await Promise.all([
    fetchTenantMetrics(tenant.id),
    PlatformUser.findAll({
      where: { tenant_id: tenant.id },
      include: [
        {
          model: Role,
          where: { code: { [Op.in]: TENANT_ADMIN_ROLE_CODES } },
          attributes: ['id', 'code', 'name'],
          through: { attributes: ['tenant_id', 'geography_id'] },
          required: true,
        },
      ],
      order: [['created_at', 'DESC']],
      limit: 50,
    }),
  ]);

  const admins = adminRows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    roleCodes: [...new Set((row.Roles || []).map((role) => role.code))],
    geographyId: row.geography_id,
    createdAt: row.created_at,
  }));

  return {
    ...mapTenant(tenant, metrics),
    admins,
  };
};

const getRegions = async (req) => {
  ensureSuperAdmin(req);
  const rows = await Geography.findAll({
    where: { level: { [Op.in]: ['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'] } },
    order: [['name', 'ASC']],
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    level: row.level,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
  }));
};

const getPlatformMetrics = async (req) => {
  ensureSuperAdmin(req);
  const [tenants, activeUsers, facilities, inspections, openAlerts] = await Promise.all([
    Tenant.count(),
    PlatformUser.count({ where: { status: 'active' } }),
    Facility.count(),
    Inspection.count(),
    Alert.count({ where: { status: { [Op.ne]: 'resolved' } } }),
  ]);
  return { tenants, activeUsers, facilities, inspections, openAlerts };
};

const getStorage = async (req) => {
  ensureSuperAdmin(req);
  const rows = await StorageUsageMetric.findAll({
    order: [['measured_at', 'DESC']],
    limit: resolveLimit(req.query.limit, 100, 1000),
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    bucketName: row.bucket_name,
    usedBytes: Number(row.used_bytes),
    objectCount: Number(row.object_count),
    measuredAt: row.measured_at,
  }));
};

const getApiUsage = async (req) => {
  ensureSuperAdmin(req);
  const now = Date.now();
  const [hourly, daily, weekly] = await Promise.all([
    AuditLog.count({ where: { created_at: { [Op.gte]: new Date(now - 60 * 60 * 1000) } } }),
    AuditLog.count({ where: { created_at: { [Op.gte]: new Date(now - 24 * 60 * 60 * 1000) } } }),
    AuditLog.count({ where: { created_at: { [Op.gte]: new Date(now - 7 * 24 * 60 * 60 * 1000) } } }),
  ]);
  return { requestsLastHour: hourly, requestsLast24Hours: daily, requestsLast7Days: weekly };
};

const getSystemHealth = async (req) => {
  ensureSuperAdmin(req);
  const [latestSensor, openIncidents, openSyncFailures] = await Promise.all([
    SensorReading.findOne({ order: [['timestamp', 'DESC']] }),
    Alert.count({ where: { status: { [Op.in]: ['open', 'acknowledged'] } } }),
    SuperAdminSyncFailure.count({ where: { status: 'open' } }),
  ]);
  return {
    status: 'ok',
    time: new Date().toISOString(),
    latestSensorReadingAt: latestSensor?.timestamp || null,
    redisEnabled: Boolean(runtimeConfig.redis.url && isRedisEnabled()),
    analysisMode: `${runtimeConfig.analysis.provider}:${runtimeConfig.analysis.openaiModel}`,
    openIncidents,
    openSyncFailures,
  };
};

const getAuditLogs = async (req) => {
  ensureSuperAdmin(req);
  const payload = await listAuditLogsService({
    ...req,
    query: {
      ...req.query,
      page: req.query.page || 1,
      limit: req.query.limit || 200,
    },
  });
  return payload;
};

const postTenantProvision = async (req) => {
  ensureSuperAdmin(req);
  return sequelize.transaction(async (transaction) => {
    const tenantCode = sanitizeText(req.body.code, 120).toUpperCase();
    const tenantName = sanitizeText(req.body.name, 200);
    const scopeLevelRaw = String(req.body.scopeLevel || 'city').trim().toLowerCase();
    const scopeLevel = TENANT_SCOPE_LEVELS.has(scopeLevelRaw) ? scopeLevelRaw : 'city';
    const countryName = req.body.countryName ? sanitizeText(req.body.countryName, 120) : null;
    const stateName = req.body.stateName ? sanitizeText(req.body.stateName, 120) : null;
    const districtName = req.body.districtName ? sanitizeText(req.body.districtName, 120) : null;
    const cityName = req.body.cityName ? sanitizeText(req.body.cityName, 120) : null;
    const zoneName = req.body.zoneName ? sanitizeText(req.body.zoneName, 120) : null;
    assertTenantScopeLocationRequirements({
      scopeLevel,
      locationNames: {
        countryName,
        stateName,
        districtName,
        cityName,
        zoneName,
      },
    });
    const existingTenant = await Tenant.findOne({
      where: { code: { [Op.iLike]: tenantCode } },
      transaction,
    });
    if (existingTenant) {
      throw new AppError('Tenant code already exists', 409, { code: 'TENANT_CODE_EXISTS' });
    }

    const metadata =
      req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
        ? { ...req.body.metadata }
        : {};
    if (req.body.plan) {
      metadata.plan = sanitizeText(req.body.plan, 80);
    }

    const tenant = await Tenant.create(
      {
        name: tenantName,
        code: tenantCode,
        status: req.body.status || 'active',
        country_code: req.body.countryCode ? sanitizeText(req.body.countryCode, 10).toUpperCase() : null,
        contact_name: req.body.contactName ? sanitizeText(req.body.contactName, 180) : null,
        contact_email: req.body.contactEmail ? sanitizeText(req.body.contactEmail, 180).toLowerCase() : null,
        contact_mobile: req.body.contactMobile ? sanitizeText(req.body.contactMobile, 32) : null,
        scope_level: scopeLevel,
        country_name: countryName,
        state_name: stateName,
        district_name: districtName,
        city_name: cityName,
        zone_name: zoneName,
        address_line: req.body.addressLine ? sanitizeText(req.body.addressLine, 300) : null,
        root_geography_id: req.body.rootGeographyId || null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      },
      { transaction }
    );

    let onboardedAdmin = null;
    if (req.body.admin) {
      onboardedAdmin = await createTenantAdminUser({
        req,
        tenant,
        admin: req.body.admin,
        transaction,
      });
    }

    await createAuditLog({
      req,
      action: 'super_admin.tenant_provision',
      entityType: 'tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      details: {
        code: tenant.code,
        status: tenant.status,
        scopeLevel: tenant.scope_level,
        plan: metadata.plan || null,
        onboardedAdminUserId: onboardedAdmin?.id || null,
      },
    });

    const metrics = await fetchTenantMetrics(tenant.id, { transaction });
    return {
      tenant: mapTenant(tenant, metrics),
      onboardedAdmin,
    };
  });
};

const patchTenant = async (req) => {
  ensureSuperAdmin(req);
  return sequelize.transaction(async (transaction) => {
    const tenant = await Tenant.findByPk(req.params.id, { transaction });
    if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });

    const nextScopeLevel =
      req.body.scopeLevel !== undefined
        ? (() => {
            const scopeLevelRaw = String(req.body.scopeLevel || '').trim().toLowerCase();
            return TENANT_SCOPE_LEVELS.has(scopeLevelRaw) ? scopeLevelRaw : tenant.scope_level;
          })()
        : tenant.scope_level;
    const nextCountryName =
      req.body.countryName !== undefined
        ? req.body.countryName
          ? sanitizeText(req.body.countryName, 120)
          : null
        : tenant.country_name;
    const nextStateName =
      req.body.stateName !== undefined
        ? req.body.stateName
          ? sanitizeText(req.body.stateName, 120)
          : null
        : tenant.state_name;
    const nextDistrictName =
      req.body.districtName !== undefined
        ? req.body.districtName
          ? sanitizeText(req.body.districtName, 120)
          : null
        : tenant.district_name;
    const nextCityName =
      req.body.cityName !== undefined
        ? req.body.cityName
          ? sanitizeText(req.body.cityName, 120)
          : null
        : tenant.city_name;
    const nextZoneName =
      req.body.zoneName !== undefined
        ? req.body.zoneName
          ? sanitizeText(req.body.zoneName, 120)
          : null
        : tenant.zone_name;
    assertTenantScopeLocationRequirements({
      scopeLevel: nextScopeLevel,
      locationNames: {
        countryName: nextCountryName,
        stateName: nextStateName,
        districtName: nextDistrictName,
        cityName: nextCityName,
        zoneName: nextZoneName,
      },
    });

    const updates = {};
    if (req.body.name !== undefined) {
      updates.name = sanitizeText(req.body.name, 200);
    }
    if (req.body.status !== undefined) {
      updates.status = req.body.status;
    }
    if (req.body.countryCode !== undefined) {
      updates.country_code = req.body.countryCode ? sanitizeText(req.body.countryCode, 10).toUpperCase() : null;
    }
    if (req.body.contactName !== undefined) {
      updates.contact_name = req.body.contactName ? sanitizeText(req.body.contactName, 180) : null;
    }
    if (req.body.contactEmail !== undefined) {
      updates.contact_email = req.body.contactEmail ? sanitizeText(req.body.contactEmail, 180).toLowerCase() : null;
    }
    if (req.body.contactMobile !== undefined) {
      updates.contact_mobile = req.body.contactMobile ? sanitizeText(req.body.contactMobile, 32) : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'externalApiSharingEnabled')) {
      updates.external_api_sharing_enabled = req.body.externalApiSharingEnabled;
    } else if (Object.prototype.hasOwnProperty.call(req.body, 'external_api_sharing_enabled')) {
      updates.external_api_sharing_enabled = req.body.external_api_sharing_enabled;
    }
    if (req.body.scopeLevel !== undefined) {
      updates.scope_level = nextScopeLevel;
    }
    if (req.body.countryName !== undefined) {
      updates.country_name = nextCountryName;
    }
    if (req.body.stateName !== undefined) {
      updates.state_name = nextStateName;
    }
    if (req.body.districtName !== undefined) {
      updates.district_name = nextDistrictName;
    }
    if (req.body.cityName !== undefined) {
      updates.city_name = nextCityName;
    }
    if (req.body.zoneName !== undefined) {
      updates.zone_name = nextZoneName;
    }
    if (req.body.addressLine !== undefined) {
      updates.address_line = req.body.addressLine ? sanitizeText(req.body.addressLine, 300) : null;
    }
    if (req.body.rootGeographyId !== undefined) {
      updates.root_geography_id = req.body.rootGeographyId || null;
    }
    if (req.body.code !== undefined) {
      const nextCode = sanitizeText(req.body.code, 120).toUpperCase();
      const duplicate = await Tenant.findOne({
        where: {
          id: { [Op.ne]: tenant.id },
          code: { [Op.iLike]: nextCode },
        },
        transaction,
      });
      if (duplicate) {
        throw new AppError('Tenant code already exists', 409, { code: 'TENANT_CODE_EXISTS' });
      }
      updates.code = nextCode;
    }

    let metadata = getTenantMetadata(tenant);
    if (req.body.metadata !== undefined) {
      if (req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)) {
        metadata = { ...metadata, ...req.body.metadata };
      } else if (req.body.metadata === null) {
        metadata = {};
      }
    }
    if (req.body.plan !== undefined) {
      if (req.body.plan) {
        metadata.plan = sanitizeText(req.body.plan, 80);
      } else {
        delete metadata.plan;
      }
    }
    if (req.body.aiScoringMode !== undefined) {
      const requestedMode = String(req.body.aiScoringMode || '').trim().toLowerCase();
      if (!AI_SCORING_MODES.has(requestedMode)) {
        throw new AppError('aiScoringMode must be light, medium, or high', 400, { code: 'INVALID_AI_SCORING_MODE' });
      }
      updates.ai_scoring_mode = requestedMode;
      metadata.aiScoringMode = requestedMode;
      metadata.aiScoringModeUpdatedAt = new Date().toISOString();
      metadata.aiScoringModeUpdatedBy = { id: req.user?.id || null, name: req.user?.fullName || req.user?.name || null };
      updates.metadata = metadata;
    }
    if (req.body.metadata !== undefined || req.body.plan !== undefined) {
      updates.metadata = Object.keys(metadata).length ? metadata : null;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date();
      await tenant.update(updates, { transaction });
    }

    await createAuditLog({
      req,
      action: 'super_admin.tenant_update',
      entityType: 'tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      details: { changedFields: Object.keys(req.body || {}) },
    });

    const refreshed = await Tenant.findByPk(tenant.id, { transaction });
    const metrics = await fetchTenantMetrics(tenant.id, { transaction });
    return mapTenant(refreshed, metrics);
  });
};

const patchTenantAiScoringMode = async (req) => {
  ensureSuperAdmin(req);
  const mode = String(req.body?.aiScoringMode || '').trim().toLowerCase();
  if (!AI_SCORING_MODES.has(mode)) throw new AppError('aiScoringMode must be light, medium, or high', 400, { code: 'INVALID_AI_SCORING_MODE' });
  const tenant = await Tenant.findByPk(req.params.id);
  if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  const previousMode = resolveAiScoringMode(tenant.ai_scoring_mode);
  const metadata = { ...getTenantMetadata(tenant), aiScoringMode: mode, aiScoringModeUpdatedAt: new Date().toISOString(), aiScoringModeUpdatedBy: { id: req.user?.id || null, name: req.user?.fullName || req.user?.name || null } };
  await tenant.update({ ai_scoring_mode: mode, metadata, updated_at: new Date() });
  await createAuditLog({ req, actorUserId: req.user?.id, tenantId: tenant.id, action: 'super_admin.tenant_ai_scoring_mode_update', entityType: 'tenant', entityId: tenant.id, details: { previousMode, newMode: mode, changedByRole: req.user?.role || req.user?.roleCodes?.[0] || 'super_admin', source: 'superadmin_tenant_details', requestId: req.id || null } });
  return mapTenant(tenant);
};

const patchFeatureFlags = async (req) => {
  ensureSuperAdmin(req);
  const config = await upsertConfig({
    configType: 'feature_flags',
    name: req.body.name || 'global_feature_flags',
    config: req.body.flags || {},
    enabled: req.body.enabled ?? true,
  });
  await createAuditLog({
    req,
    action: 'super_admin.feature_flags_update',
    entityType: 'integration_config',
    entityId: config.id,
  });
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    flags: config.config_json,
  };
};

const getActionCenter = async (req) => {
  ensureSuperAdmin(req);
  const [approvals, syncFailures, supportTickets, queue, tenants, recentHistory] = await Promise.all([
    SuperAdminApproval.findAll({
      where: { status: 'pending' },
      order: [['created_at', 'DESC']],
    }),
    SuperAdminSyncFailure.findAll({
      where: { status: 'open' },
      order: [['first_seen_at', 'DESC']],
    }),
    SuperAdminSupportTicket.findAll({
      where: { status: { [Op.in]: ['open', 'in_progress'] } },
      order: [['created_at', 'DESC']],
    }),
    getQueueMetrics(ANALYSIS_QUEUE),
    Tenant.findAll({
      attributes: ['id', 'name', 'city_name'],
    }),
    AuditLog.findAll({
      where: {
        action: {
          [Op.in]: [
            'super_admin.approval_update',
            'super_admin.sync_failure_update',
            'super_admin.support_ticket_update',
          ],
        },
      },
      order: [['created_at', 'DESC']],
      limit: 20,
    }),
  ]);

  const userIds = new Set();
  approvals.forEach((row) => {
    if (row.requested_by_user_id) userIds.add(row.requested_by_user_id);
  });
  supportTickets.forEach((row) => {
    if (row.opened_by_user_id) userIds.add(row.opened_by_user_id);
    if (row.assigned_to_user_id) userIds.add(row.assigned_to_user_id);
  });
  recentHistory.forEach((row) => {
    if (row.actor_user_id) userIds.add(row.actor_user_id);
  });
  const users = userIds.size > 0
    ? await PlatformUser.findAll({
        where: { id: { [Op.in]: [...userIds] } },
        attributes: ['id', 'full_name'],
      })
    : [];

  const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const userMap = new Map(users.map((user) => [user.id, user.full_name]));
  const tenantContext = (tenantId) => {
    const tenant = tenantMap.get(tenantId);
    return {
      tenantName: tenant?.name || '',
      cityName: tenant?.city_name || '',
    };
  };
  const readable = (value, fallback = 'Platform operations') => {
    const text = String(value || '').trim();
    if (!text) return fallback;
    return text
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase());
  };
  const dueAfterHours = (value, hours) => {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp)
      ? new Date(timestamp + hours * 60 * 60 * 1000).toISOString()
      : null;
  };
  const syncSlaHours = {
    critical: 1,
    high: 4,
    medium: 8,
    low: 24,
  };
  const supportSlaHours = {
    critical: 2,
    high: 8,
    medium: 24,
    low: 48,
  };

  const approvalItems = approvals.map((row) => ({
    id: row.id,
    category: 'approval',
    priority: String(row.category || '').toLowerCase().includes('critical') ? 'high' : 'medium',
    title: `Review ${readable(row.category, 'approval request')}`,
    description: row.notes || `Approval requested for ${readable(row.entity_type, 'platform record')}.`,
    ...tenantContext(row.tenant_id),
    module: readable(row.entity_type),
    status: 'pending',
    createdAt: row.created_at,
    dueAt: dueAfterHours(row.created_at, 24),
    relatedEntityType: row.entity_type,
    relatedEntityId: row.entity_id || row.id,
    userName: userMap.get(row.requested_by_user_id) || '',
    actions: ['view', 'approve', 'reject'],
  }));

  const syncItems = syncFailures.map((row) => ({
    id: row.id,
    category: 'sync_failure',
    priority: row.severity,
    title: `Sync failure in ${readable(row.source_module)}`,
    description: row.reason,
    ...tenantContext(row.tenant_id),
    module: readable(row.source_module),
    status: 'failed',
    createdAt: row.first_seen_at,
    dueAt: dueAfterHours(row.first_seen_at, syncSlaHours[row.severity] || 8),
    relatedEntityType: 'sync_failure',
    relatedEntityId: row.reference_id || row.id,
    issueId: row.reference_id || row.id,
    actions: ['view_logs', 'retry', 'mark_resolved'],
  }));

  const supportItems = supportTickets.map((row) => ({
    id: row.id,
    category: 'support_ticket',
    priority: row.severity,
    title: row.subject,
    description: row.description,
    ...tenantContext(row.tenant_id),
    module: readable(row.metadata?.module, 'Support operations'),
    status: row.status,
    createdAt: row.created_at,
    dueAt: dueAfterHours(row.created_at, supportSlaHours[row.severity] || 24),
    relatedEntityType: 'support_ticket',
    relatedEntityId: row.id,
    issueId: row.id,
    userName: userMap.get(row.opened_by_user_id) || '',
    assignedTo: userMap.get(row.assigned_to_user_id) || '',
    metadata: row.metadata || null,
    actions: ['view', 'assign', 'update_status', 'close'],
  }));

  const queueBacklog = Number(queue.counts.waiting || 0) + Number(queue.counts.active || 0);
  const now = new Date();
  const queueItems = queueBacklog > 0
    ? [{
        id: `queue:${ANALYSIS_QUEUE}`,
        category: 'queue_job',
        priority: queueBacklog > 50 ? 'critical' : queueBacklog > 10 ? 'high' : 'medium',
        title: `${readable(ANALYSIS_QUEUE)} backlog`,
        description: `${queue.counts.waiting || 0} waiting and ${queue.counts.active || 0} active jobs require monitoring.`,
        tenantName: '',
        cityName: '',
        module: 'Inspection analysis',
        status: 'pending',
        createdAt: now.toISOString(),
        dueAt: dueAfterHours(now, 2),
        relatedEntityType: 'queue',
        relatedEntityId: ANALYSIS_QUEUE,
        quantity: queueBacklog,
        actions: ['view_logs', 'retry', 'cancel'],
      }]
    : [];

  const items = [
    ...approvalItems,
    ...syncItems,
    ...supportItems,
    ...queueItems,
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  const historyCategory = {
    super_admin_approval: 'approval',
    super_admin_sync_failure: 'sync_failure',
    super_admin_support_ticket: 'support_ticket',
  };
  const historyActionLabel = (row) => {
    if (row.details?.actionLabel) return row.details.actionLabel;
    if (row.entity_type === 'super_admin_approval') {
      if (row.details?.status === 'approved') return 'Approve';
      if (row.details?.status === 'rejected') return 'Reject';
      return 'Update approval';
    }
    if (row.entity_type === 'super_admin_sync_failure') {
      return row.details?.status === 'resolved' ? 'Mark resolved' : 'Retry';
    }
    if (row.entity_type === 'super_admin_support_ticket') {
      if (row.details?.status === 'closed') return 'Close';
      if (row.details?.status === 'resolved') return 'Update status';
      return 'Assign';
    }
    return 'Update';
  };
  const history = recentHistory.map((row) => ({
    id: row.id,
    action: historyActionLabel(row),
    category: historyCategory[row.entity_type] || 'platform_health_alert',
    target: row.details?.target || `${readable(row.entity_type)} ${String(row.entity_id || '').slice(0, 8)}`.trim(),
    performedBy: userMap.get(row.actor_user_id) || 'Super Admin',
    remark: row.details?.remark || '',
    time: row.created_at,
  }));

  return {
    counters: {
      pendingApprovals: approvalItems.length,
      openSyncFailures: syncItems.length,
      openSupportTickets: supportItems.length,
      queueBacklog,
    },
    items,
    history,
  };
};

const getNotificationsFeed = async (req) => {
  ensureSuperAdmin(req);
  const where = {};
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  if (req.query.status) {
    where[Op.or] = [
      { status: req.query.status },
      { delivery_state: String(req.query.status).toUpperCase() },
    ];
  }
  const rows = await NotificationEvent.findAll({
    where,
    order: [['created_at', 'DESC']],
    limit: resolveLimit(req.query.limit, 100, 1000),
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    eventType: row.event_type,
    notificationType: row.notification_type || null,
    priority: row.priority || null,
    title: row.title || row.payload?.title || null,
    body: row.body || row.payload?.body || row.payload?.message || null,
    route: row.route || row.payload?.route || null,
    channel: row.channel,
    payload: row.payload,
    status: row.delivery_state || row.status,
    createdAt: row.created_at,
  }));
};

const getMultiCityRollups = async (req) => {
  ensureSuperAdmin(req);
  const [tenants, geographies, facilityCounts] = await Promise.all([
    Tenant.findAll({
      attributes: [
        'id',
        'name',
        'code',
        'status',
        'scope_level',
        'country_code',
        'country_name',
        'state_name',
        'district_name',
        'city_name',
        'zone_name',
        'address_line',
        'root_geography_id',
      ],
      order: [['name', 'ASC']],
      raw: true,
    }),
    Geography.findAll({
      attributes: [
        'id',
        'parent_id',
        'level',
        'code',
        'name',
        'centroid_latitude',
        'centroid_longitude',
        'boundary_center_latitude',
        'boundary_center_longitude',
      ],
      order: [['level', 'ASC'], ['name', 'ASC']],
      raw: true,
    }),
    Facility.findAll({
      attributes: ['tenant_id', [fn('COUNT', col('id')), 'count']],
      group: ['tenant_id'],
      raw: true,
    }),
  ]);
  const geographyById = new Map(geographies.map((row) => [row.id, row]));
  const facilityCountByTenant = new Map(
    facilityCounts.map((row) => [row.tenant_id, Number(row.count || 0)])
  );

  return tenants.map((tenant) =>
    toMultiCityRollup(tenant, geographyById, facilityCountByTenant.get(tenant.id) || 0)
  );
};

const getOrganizations = async (req) => {
  ensureSuperAdmin(req);
  const tenants = await Tenant.findAll({ order: [['name', 'ASC']] });
  const tenantIds = tenants.map((tenant) => tenant.id);
  if (tenantIds.length === 0) {
    return [];
  }

  const tenantAdminRole = await Role.findOne({ where: { code: 'tenant_admin' }, attributes: ['id'] });
  const [facilityCounts, userCounts, alertCounts, tenantAdminCounts] = await Promise.all([
    Facility.findAll({
      attributes: ['tenant_id', [fn('COUNT', col('id')), 'count']],
      where: { tenant_id: { [Op.in]: tenantIds } },
      group: ['tenant_id'],
      raw: true,
    }),
    PlatformUser.findAll({
      attributes: ['tenant_id', [fn('COUNT', col('id')), 'count']],
      where: { tenant_id: { [Op.in]: tenantIds }, status: 'active' },
      group: ['tenant_id'],
      raw: true,
    }),
    Alert.findAll({
      attributes: ['tenant_id', [fn('COUNT', col('id')), 'count']],
      where: {
        tenant_id: { [Op.in]: tenantIds },
        status: { [Op.in]: ['open', 'acknowledged'] },
      },
      group: ['tenant_id'],
      raw: true,
    }),
    tenantAdminRole
      ? UserRole.findAll({
          attributes: ['tenant_id', [fn('COUNT', col('id')), 'count']],
          where: {
            tenant_id: { [Op.in]: tenantIds },
            role_id: tenantAdminRole.id,
          },
          group: ['tenant_id'],
          raw: true,
        })
      : Promise.resolve([]),
  ]);

  const facilityMap = new Map(facilityCounts.map((row) => [row.tenant_id, Number(row.count || 0)]));
  const userMap = new Map(userCounts.map((row) => [row.tenant_id, Number(row.count || 0)]));
  const alertMap = new Map(alertCounts.map((row) => [row.tenant_id, Number(row.count || 0)]));
  const tenantAdminMap = new Map(tenantAdminCounts.map((row) => [row.tenant_id, Number(row.count || 0)]));

  return tenants.map((tenant) => ({
    ...mapTenant(tenant),
    metrics: {
      facilities: facilityMap.get(tenant.id) || 0,
      activeUsers: userMap.get(tenant.id) || 0,
      openAlerts: alertMap.get(tenant.id) || 0,
      tenantAdmins: tenantAdminMap.get(tenant.id) || 0,
    },
  }));
};

const getClientWorkspace = async (req) => {
  ensureSuperAdmin(req);
  const tenantId = req.query.tenantId;
  if (!tenantId) throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });

  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });

  const [facilities, users, alerts, projects] = await Promise.all([
    Facility.findAll({ where: { tenant_id: tenantId }, order: [['name', 'ASC']], limit: 100 }),
    PlatformUser.findAll({ where: { tenant_id: tenantId }, order: [['created_at', 'DESC']], limit: 100 }),
    Alert.findAll({ where: { tenant_id: tenantId }, order: [['created_at', 'DESC']], limit: 25 }),
    SuperAdminProject.findAll({ where: { tenant_id: tenantId }, order: [['updated_at', 'DESC']], limit: 50 }),
  ]);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      code: tenant.code,
      status: tenant.status,
      countryCode: tenant.country_code,
    },
    summary: {
      facilities: facilities.length,
      users: users.length,
      openAlerts: alerts.filter((row) => row.status !== 'resolved').length,
      activeProjects: projects.filter((row) => row.status === 'active').length,
    },
    facilities: facilities.map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status })),
    users: users.map((row) => ({ id: row.id, fullName: row.full_name, email: row.email, status: row.status })),
    recentAlerts: alerts.map((row) => ({
      id: row.id,
      severity: row.severity,
      message: row.message,
      status: row.status,
      createdAt: row.created_at,
    })),
    projects: projects.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    })),
  };
};

const listProjects = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 200 });
  const where = {};
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  if (req.query.status) where.status = req.query.status;
  const { rows, count } = await SuperAdminProject.findAndCountAll({
    where,
    order: [['updated_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      code: row.code,
      category: row.category,
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      geographyId: row.geography_id,
      metadata: row.metadata,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createProject = async (req) => {
  ensureSuperAdmin(req);
  const row = await SuperAdminProject.create({
    tenant_id: req.body.tenantId || null,
    name: sanitizeText(req.body.name, 220),
    code: sanitizeText(req.body.code, 120),
    category: sanitizeText(req.body.category || 'deployment', 80),
    status: req.body.status || 'planned',
    starts_at: req.body.startsAt ? new Date(req.body.startsAt) : null,
    ends_at: req.body.endsAt ? new Date(req.body.endsAt) : null,
    geography_id: req.body.geographyId || null,
    metadata: req.body.metadata || null,
  });
  await createAuditLog({
    req,
    action: 'super_admin.project_create',
    entityType: 'super_admin_project',
    entityId: row.id,
    tenantId: row.tenant_id,
  });
  return row;
};

const getTopology = async (req) => {
  ensureSuperAdmin(req);
  const tenants = await Tenant.findAll({ order: [['name', 'ASC']] });
  const tenantIds = tenants.map((tenant) => tenant.id);
  const [facilities, sensors, projects] = await Promise.all([
    Facility.findAll({ attributes: ['tenant_id'], where: { tenant_id: { [Op.in]: tenantIds } }, raw: true }),
    SensorDevice.findAll({ attributes: ['tenant_id', 'status'], where: { tenant_id: { [Op.in]: tenantIds } }, raw: true }),
    SuperAdminProject.findAll({ attributes: ['tenant_id', 'status'], where: { tenant_id: { [Op.in]: tenantIds } }, raw: true }),
  ]);
  return tenants.map((tenant) => ({
    tenantId: tenant.id,
    tenantName: tenant.name,
    facilities: facilities.filter((row) => row.tenant_id === tenant.id).length,
    sensors: sensors.filter((row) => row.tenant_id === tenant.id).length,
    activeSensors: sensors.filter((row) => row.tenant_id === tenant.id && row.status === 'active').length,
    activeProjects: projects.filter((row) => row.tenant_id === tenant.id && row.status === 'active').length,
  }));
};

const getGlobalUsers = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 200 });
  const where = {};
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  if (req.query.status) where.status = req.query.status;
  if (req.query.search) {
    const query = sanitizeText(req.query.search, 120);
    where[Op.or] = [
      { full_name: { [Op.iLike]: `%${query}%` } },
      { email: { [Op.iLike]: `%${query}%` } },
      { phone: { [Op.iLike]: `%${query}%` } },
      { employee_code: { [Op.iLike]: `%${query}%` } },
    ];
  }
  const { rows, count } = await PlatformUser.findAndCountAll({
    where,
    include: [
      { model: Tenant, attributes: ['id', 'name', 'code', 'status'] },
      {
        model: Role,
        attributes: ['id', 'code', 'name'],
        through: { attributes: ['tenant_id', 'geography_id'] },
      },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
  });
  return {
    items: rows.map((row) => {
      const memberships = [...new Set(
        (row.Roles || []).map((role) =>
          JSON.stringify({
            roleCode: role.code,
            roleName: role.name,
            tenantId: role?.UserRole?.tenant_id || row.tenant_id || null,
            geographyId: role?.UserRole?.geography_id || row.geography_id || null,
          })
        )
      )].map((serialized) => JSON.parse(serialized));

      return {
        id: row.id,
        tenantId: row.tenant_id,
        tenantName: row.Tenant?.name || null,
        tenantCode: row.Tenant?.code || null,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        employeeCode: row.employee_code || null,
        status: row.status,
        lastLoginAt: row.last_login_at,
        roleCodes: [...new Set((row.Roles || []).map((role) => role.code))],
        memberships,
      };
    }),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const getRolesPermissions = async (req) => {
  ensureSuperAdmin(req);
  const [roles, permissions] = await Promise.all([
    Role.findAll({ include: [{ model: Permission }], order: [['name', 'ASC']] }),
    Permission.findAll({ order: [['name', 'ASC']] }),
  ]);
  return {
    roles: roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      permissionCodes: (role.Permissions || []).map((item) => item.code),
    })),
    permissions: permissions.map((permission) => ({
      id: permission.id,
      code: permission.code,
      name: permission.name,
      description: permission.description,
    })),
  };
};

const listApprovals = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 200 });
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  const { rows, count } = await SuperAdminApproval.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      category: row.category,
      entityType: row.entity_type,
      entityId: row.entity_id,
      status: row.status,
      requestedByUserId: row.requested_by_user_id,
      reviewedByUserId: row.reviewed_by_user_id,
      notes: row.notes,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createApproval = async (req) => {
  ensureSuperAdmin(req);
  const row = await SuperAdminApproval.create({
    tenant_id: req.body.tenantId || null,
    requested_by_user_id: req.user.id,
    category: sanitizeText(req.body.category, 120),
    entity_type: sanitizeText(req.body.entityType, 120),
    entity_id: req.body.entityId ? String(req.body.entityId) : null,
    status: req.body.status || 'pending',
    notes: req.body.notes ? sanitizeText(req.body.notes, 800) : null,
  });
  await createAuditLog({
    req,
    action: 'super_admin.approval_create',
    entityType: 'super_admin_approval',
    entityId: row.id,
    tenantId: row.tenant_id,
  });
  return row;
};

const patchApprovalStatus = async (req) => {
  ensureSuperAdmin(req);
  const row = await SuperAdminApproval.findByPk(req.params.id);
  if (!row) throw new AppError('Approval not found', 404, { code: 'APPROVAL_NOT_FOUND' });
  await row.update({
    status: req.body.status,
    reviewed_by_user_id: req.user.id,
    reviewed_at: new Date(),
    notes: req.body.notes ? sanitizeText(req.body.notes, 800) : row.notes,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'super_admin.approval_update',
    entityType: 'super_admin_approval',
    entityId: row.id,
    tenantId: row.tenant_id,
    details: {
      status: req.body.status,
      target: row.category,
      remark: req.body.notes ? sanitizeText(req.body.notes, 800) : '',
    },
  });
  return row;
};

const getMasterData = async (req) => {
  ensureSuperAdmin(req);
  const [roles, permissions, geographies, facilityTypes] = await Promise.all([
    Role.count(),
    Permission.count(),
    Geography.count(),
    Facility.findAll({
      attributes: ['facility_type', [fn('COUNT', col('id')), 'count']],
      group: ['facility_type'],
      raw: true,
    }),
  ]);
  return {
    totals: {
      roles,
      permissions,
      geographies,
      facilityTypes: facilityTypes.length,
    },
    facilityTypes: facilityTypes.map((row) => ({
      facilityType: row.facility_type,
      count: Number(row.count || 0),
    })),
  };
};

const getScoringThresholds = async (req) => {
  ensureSuperAdmin(req);
  const rows = await getConfigs('scoring_thresholds');
  return rows.map(mapConfigRow);
};

const patchScoringThresholds = async (req) => {
  ensureSuperAdmin(req);
  return upsertConfig({
    configType: 'scoring_thresholds',
    name: req.body.name || 'global_scoring_thresholds',
    config: req.body.config || req.body.thresholds || {},
    enabled: req.body.enabled ?? true,
  });
};

const getEscalationPolicies = async (req) => {
  ensureSuperAdmin(req);
  const rows = await getConfigs('escalation_policies');
  return rows.map(mapConfigRow);
};

const patchEscalationPolicies = async (req) => {
  ensureSuperAdmin(req);
  return upsertConfig({
    configType: 'escalation_policies',
    name: req.body.name || 'global_escalation_policies',
    config: req.body.config || req.body.policy || {},
    enabled: req.body.enabled ?? true,
  });
};

const getTemplates = async (req) => {
  ensureSuperAdmin(req);
  const rows = await getConfigs('message_template');
  return rows.map(mapConfigRow);
};

const upsertTemplate = async (req) => {
  ensureSuperAdmin(req);
  return upsertConfig({
    configType: 'message_template',
    name: req.body.name,
    config: req.body.config || req.body.template || {},
    enabled: req.body.enabled ?? true,
  });
};

const getLocalization = async (req) => {
  ensureSuperAdmin(req);
  const rows = await getConfigs('localization');
  return rows.map(mapConfigRow);
};

const patchLocalization = async (req) => {
  ensureSuperAdmin(req);
  return upsertConfig({
    configType: 'localization',
    name: req.body.name || 'global_localization',
    config: req.body.config || {},
    enabled: req.body.enabled ?? true,
  });
};

const getPlatformAnalytics = async (req) => {
  ensureSuperAdmin(req);
  const days = Math.min(Number(req.query.days || 14), 90);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const [inspectionRows, aggregateRows] = await Promise.all([
    Inspection.findAll({
      attributes: [[fn('DATE', col('captured_at')), 'date'], [fn('COUNT', col('id')), 'count']],
      where: { captured_at: { [Op.gte]: start } },
      group: [literal('DATE("Inspection"."captured_at")')],
      raw: true,
    }),
    DashboardAggregate.findAll({
      where: { aggregate_date: { [Op.gte]: start.toISOString().slice(0, 10) } },
      order: [['aggregate_date', 'ASC']],
      raw: true,
    }),
  ]);
  return {
    inspections: inspectionRows.map((row) => ({ date: String(row.date), count: Number(row.count || 0) })),
    aggregates: aggregateRows.map((row) => ({ date: row.aggregate_date, metrics: row.metrics })),
  };
};

const getStorageAnalytics = async (req) => {
  ensureSuperAdmin(req);
  const rows = await StorageUsageMetric.findAll({
    order: [['measured_at', 'ASC']],
    limit: resolveLimit(req.query.limit, 200, 2000),
  });
  const grouped = new Map();
  rows.forEach((row) => {
    const date = new Date(row.measured_at).toISOString().slice(0, 10);
    const current = grouped.get(date) || { date, usedBytes: 0, objectCount: 0 };
    current.usedBytes += Number(row.used_bytes || 0);
    current.objectCount += Number(row.object_count || 0);
    grouped.set(date, current);
  });
  return { points: [...grouped.values()] };
};

const getAiUsage = async (req) => {
  ensureSuperAdmin(req);
  const [daily, byModel] = await Promise.all([
    AiAnalysisResult.findAll({
      attributes: [[fn('DATE', col('processed_at')), 'date'], [fn('COUNT', col('id')), 'count']],
      group: [literal('DATE("AiAnalysisResult"."processed_at")')],
      raw: true,
      order: [[literal('DATE("AiAnalysisResult"."processed_at")'), 'ASC']],
    }),
    AiAnalysisResult.findAll({
      attributes: ['model_name', 'model_version', [fn('COUNT', col('id')), 'count']],
      group: ['model_name', 'model_version'],
      raw: true,
      order: [[literal('count'), 'DESC']],
    }),
  ]);
  return {
    daily: daily.map((row) => ({ date: String(row.date), count: Number(row.count || 0) })),
    byModel: byModel.map((row) => ({
      modelName: row.model_name,
      modelVersion: row.model_version,
      count: Number(row.count || 0),
    })),
  };
};

const getQueueHealth = async (req) => {
  ensureSuperAdmin(req);
  return {
    redisEnabled: isRedisEnabled(),
    queues: [await getQueueMetrics(ANALYSIS_QUEUE)],
  };
};

const getSyncFailures = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 50, maxLimit: 500 });
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  if (req.query.severity) where.severity = req.query.severity;
  const { rows, count } = await SuperAdminSyncFailure.findAndCountAll({
    where,
    order: [['last_seen_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      sourceModule: row.source_module,
      referenceId: row.reference_id,
      severity: row.severity,
      reason: row.reason,
      status: row.status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at,
      payload: row.payload,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const patchSyncFailureStatus = async (req) => {
  ensureSuperAdmin(req);
  const row = await SuperAdminSyncFailure.findByPk(req.params.id);
  if (!row) throw new AppError('Sync failure not found', 404, { code: 'SYNC_FAILURE_NOT_FOUND' });
  await row.update({
    status: req.body.status,
    resolved_at: req.body.status === 'resolved' ? new Date() : null,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'super_admin.sync_failure_update',
    entityType: 'super_admin_sync_failure',
    entityId: row.id,
    tenantId: row.tenant_id,
    details: {
      status: req.body.status,
      actionLabel: req.body.action === 'retry' ? 'Retry' : req.body.action === 'mark_resolved' ? 'Mark resolved' : null,
      target: row.reason,
      remark: req.body.remark ? sanitizeText(req.body.remark, 800) : '',
    },
  });
  return row;
};

const getDeviceFleet = async (req) => {
  ensureSuperAdmin(req);
  const devices = await SensorDevice.findAll({ order: [['last_seen_at', 'DESC']], limit: resolveLimit(req.query.limit, 1000, 5000) });
  const now = Date.now();
  const staleMs = Number(req.query.staleMinutes || 60) * 60 * 1000;
  const counters = { total: devices.length, active: 0, inactive: 0, faulty: 0, stale: 0 };
  const staleDevices = [];
  devices.forEach((device) => {
    if (device.status === 'active') counters.active += 1;
    if (device.status === 'inactive') counters.inactive += 1;
    if (device.status === 'faulty') counters.faulty += 1;
    const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
    if (!lastSeen || now - lastSeen > staleMs) {
      counters.stale += 1;
      staleDevices.push({
        id: device.id,
        tenantId: device.tenant_id,
        facilityId: device.facility_id,
        deviceId: device.device_id,
        status: device.status,
        lastSeenAt: device.last_seen_at,
      });
    }
  });
  return { counters, staleDevices: staleDevices.slice(0, 200) };
};

const getTenantHealth = async (req) => {
  ensureSuperAdmin(req);
  const rows = await SuperAdminTenantHealth.findAll({
    order: [['snapshot_at', 'DESC']],
    limit: resolveLimit(req.query.limit, 200, 2000),
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    snapshotAt: row.snapshot_at,
    healthScore: toNumber(row.health_score, 0),
    openAlerts: row.open_alerts,
    pendingTasks: row.pending_tasks,
    failedSyncs: row.failed_syncs,
    activeSensors: row.active_sensors,
    totalSensors: row.total_sensors,
    metadata: row.metadata,
  }));
};

const getSupportConsole = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 200 });
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.severity) where.severity = req.query.severity;
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  const { rows, count } = await SuperAdminSupportTicket.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      subject: row.subject,
      description: row.description,
      severity: row.severity,
      status: row.status,
      openedByUserId: row.opened_by_user_id,
      assignedToUserId: row.assigned_to_user_id,
      resolvedAt: row.resolved_at,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createSupportTicket = async (req) => {
  ensureSuperAdmin(req);
  const row = await SuperAdminSupportTicket.create({
    tenant_id: req.body.tenantId || null,
    opened_by_user_id: req.user.id,
    assigned_to_user_id: req.body.assignedToUserId || null,
    subject: sanitizeText(req.body.subject, 240),
    description: sanitizeText(req.body.description, 2000),
    severity: req.body.severity || 'medium',
    status: req.body.status || 'open',
    metadata: req.body.metadata || null,
  });
  return row;
};

const patchSupportTicket = async (req) => {
  ensureSuperAdmin(req);
  const row = await SuperAdminSupportTicket.findByPk(req.params.id);
  if (!row) throw new AppError('Support ticket not found', 404, { code: 'SUPPORT_TICKET_NOT_FOUND' });
  await row.update({
    status: req.body.status || row.status,
    severity: req.body.severity || row.severity,
    assigned_to_user_id: req.body.assignedToUserId ?? row.assigned_to_user_id,
    resolved_at: req.body.status === 'resolved' ? new Date() : row.resolved_at,
    metadata: req.body.metadata ?? row.metadata,
    updated_at: new Date(),
  });
  const actionName = req.body.metadata?.actionCenterAction;
  const actionLabel = {
    assign: 'Assign',
    update_status: 'Update status',
    close: 'Close',
  }[actionName] || null;
  await createAuditLog({
    req,
    action: 'super_admin.support_ticket_update',
    entityType: 'super_admin_support_ticket',
    entityId: row.id,
    tenantId: row.tenant_id,
    details: {
      status: row.status,
      actionLabel,
      target: row.subject,
      remark: req.body.metadata?.actionCenterRemark
        ? sanitizeText(req.body.metadata.actionCenterRemark, 800)
        : '',
    },
  });
  return row;
};

const listIntegrations = async (req) => {
  ensureSuperAdmin(req);
  const where = { tenant_id: null };
  if (req.query.configType) where.config_type = req.query.configType;
  const rows = await IntegrationConfig.findAll({
    where,
    order: [['updated_at', 'DESC']],
    limit: resolveLimit(req.query.limit, 200, 1000),
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    configType: row.config_type,
    configJson: row.config_json,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  }));
};

const upsertIntegration = async (req) => {
  ensureSuperAdmin(req);
  return upsertConfig({
    configType: req.body.configType,
    name: req.body.name,
    config: req.body.configJson,
    enabled: req.body.enabled ?? true,
  });
};

const listReleases = async (req) => {
  ensureSuperAdmin(req);
  const where = {};
  if (req.query.environment) where.environment = req.query.environment;
  if (req.query.status) where.status = req.query.status;
  const rows = await SuperAdminReleaseRecord.findAll({
    where,
    order: [['created_at', 'DESC']],
    limit: resolveLimit(req.query.limit, 200, 1000),
  });
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    environment: row.environment,
    status: row.status,
    deployedByUserId: row.deployed_by_user_id,
    deployedAt: row.deployed_at,
    notes: row.notes,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
};

const createRelease = async (req) => {
  ensureSuperAdmin(req);
  return SuperAdminReleaseRecord.create({
    version: sanitizeText(req.body.version, 80),
    environment: sanitizeText(req.body.environment, 40),
    status: req.body.status || 'planned',
    deployed_by_user_id: req.user.id,
    deployed_at: req.body.deployedAt ? new Date(req.body.deployedAt) : null,
    notes: req.body.notes ? sanitizeText(req.body.notes, 1200) : null,
    metadata: req.body.metadata || null,
  });
};

const listBackups = async (req) => {
  ensureSuperAdmin(req);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  const rows = await SuperAdminBackupRecord.findAll({
    where,
    order: [['created_at', 'DESC']],
    limit: resolveLimit(req.query.limit, 200, 1000),
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    backupType: row.backup_type,
    storageKey: row.storage_key,
    sizeBytes: Number(row.size_bytes || 0),
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    retentionUntil: row.retention_until,
    metadata: row.metadata,
  }));
};

const createBackup = async (req) => {
  ensureSuperAdmin(req);
  return SuperAdminBackupRecord.create({
    tenant_id: req.body.tenantId || null,
    backup_type: sanitizeText(req.body.backupType || 'database', 60),
    storage_key: req.body.storageKey ? sanitizeText(req.body.storageKey, 500) : null,
    size_bytes: req.body.sizeBytes || null,
    status: req.body.status || 'queued',
    started_at: req.body.startedAt ? new Date(req.body.startedAt) : new Date(),
    completed_at: req.body.completedAt ? new Date(req.body.completedAt) : null,
    retention_until: req.body.retentionUntil ? new Date(req.body.retentionUntil) : null,
    metadata: req.body.metadata || null,
  });
};

const getPolicy = async (req) => {
  ensureSuperAdmin(req);
  const rows = await getConfigs('policy_document');
  return rows.map(mapConfigRow);
};

const patchPolicy = async (req) => {
  ensureSuperAdmin(req);
  return upsertConfig({
    configType: 'policy_document',
    name: req.body.name || 'global_policy_docs',
    config: req.body.config || req.body.policy || {},
    enabled: req.body.enabled ?? true,
  });
};

const getReliability = async (req) => {
  ensureSuperAdmin(req);
  const [openAlerts, faultySensors, activeSensors, totalSensors, openSyncFailures] = await Promise.all([
    Alert.count({ where: { status: { [Op.in]: ['open', 'acknowledged'] } } }),
    SensorDevice.count({ where: { status: 'faulty' } }),
    SensorDevice.count({ where: { status: 'active' } }),
    SensorDevice.count(),
    SuperAdminSyncFailure.count({ where: { status: 'open' } }),
  ]);
  const sensorUptimePercent = totalSensors === 0 ? 100 : Number(((activeSensors / totalSensors) * 100).toFixed(2));
  const reliabilityScore = Math.max(0, Math.min(100, sensorUptimePercent - openAlerts - faultySensors * 1.5 - openSyncFailures * 2));
  return {
    sensorUptimePercent,
    openAlerts,
    faultySensors,
    openSyncFailures,
    reliabilityScore: Number(reliabilityScore.toFixed(2)),
  };
};

const getSettings = async (req) => {
  ensureSuperAdmin(req);
  const [featureFlags, scoringThresholds, escalationPolicies, localization, policyDocuments] = await Promise.all([
    getConfigs('feature_flags'),
    getConfigs('scoring_thresholds'),
    getConfigs('escalation_policies'),
    getConfigs('localization'),
    getConfigs('policy_document'),
  ]);
  return {
    featureFlags: featureFlags.map(mapConfigRow),
    scoringThresholds: scoringThresholds.map(mapConfigRow),
    escalationPolicies: escalationPolicies.map(mapConfigRow),
    localization: localization.map(mapConfigRow),
    policyDocuments: policyDocuments.map(mapConfigRow),
  };
};

const patchSettings = async (req) => {
  ensureSuperAdmin(req);
  const sections = req.body.sections || {};
  const updateMap = [
    ['featureFlags', 'feature_flags', 'global_feature_flags'],
    ['scoringThresholds', 'scoring_thresholds', 'global_scoring_thresholds'],
    ['escalationPolicies', 'escalation_policies', 'global_escalation_policies'],
    ['localization', 'localization', 'global_localization'],
    ['policyDocuments', 'policy_document', 'global_policy_docs'],
  ];
  const updated = [];
  for (const [key, configType, defaultName] of updateMap) {
    if (!sections[key]) continue;
    const payload = sections[key];
    const row = await upsertConfig({
      configType,
      name: payload.name || defaultName,
      config: payload.config || {},
      enabled: payload.enabled ?? true,
    });
    updated.push(mapConfigRow(row));
  }
  return { updated };
};

module.exports = {
  getTenants,
  getTenantById,
  getRegions,
  getPlatformMetrics,
  getStorage,
  getApiUsage,
  getSystemHealth,
  getAuditLogs,
  postTenantProvision,
  patchTenant,
  patchTenantAiScoringMode,
  patchFeatureFlags,
  getActionCenter,
  getNotificationsFeed,
  getMultiCityRollups,
  getOrganizations,
  getClientWorkspace,
  listProjects,
  createProject,
  getTopology,
  getGlobalUsers,
  getRolesPermissions,
  listApprovals,
  createApproval,
  patchApprovalStatus,
  getMasterData,
  getScoringThresholds,
  patchScoringThresholds,
  getEscalationPolicies,
  patchEscalationPolicies,
  getTemplates,
  upsertTemplate,
  getLocalization,
  patchLocalization,
  getPlatformAnalytics,
  getStorageAnalytics,
  getAiUsage,
  getQueueHealth,
  getSyncFailures,
  patchSyncFailureStatus,
  getDeviceFleet,
  getTenantHealth,
  getSupportConsole,
  createSupportTicket,
  patchSupportTicket,
  listIntegrations,
  upsertIntegration,
  listReleases,
  createRelease,
  listBackups,
  createBackup,
  getPolicy,
  patchPolicy,
  getReliability,
  getSettings,
  patchSettings,
};
