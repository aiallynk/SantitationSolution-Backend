const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  PlatformUser,
  Role,
  Permission,
  UserRole,
  Tenant,
  Geography,
  TenantGeographyAssignment,
  Facility,
  ToiletUnit,
  WorkerAssignment,
} = require('../../models');
const { normalizePagination, sanitizeText, isUuid } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { resolveOrCreateTenantGeographyFromGlobal } = require('../geography-master/activation.service');
const { assertRoleScopeRequirements } = require('../../core/rbac/roleScopeRules');
const {
  getPersonaFamily,
  getRequiredScopeType,
  normalizeRoleCode,
  ROLE_CODES,
} = require('../../core/rbac/personaFamilies');
const {
  assertRoleDelegationAllowed,
  uniqueNormalizedRoleCodes,
} = require('../../core/rbac/roleDelegationRules');
const {
  assertPersonaLocationScope,
  getPersonaScopeLevel,
  normalizePersonaLocationNames,
} = require('../../core/rbac/personaLocationScope');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  uniqueIds,
  isGeographyInScope,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');
const {
  generateTemporaryPassword,
  hashPassword,
  assertPasswordPolicy,
} = require('../auth/passwordLifecycle.service');

const GLOBAL_ROLE_CODES = new Set(['super_admin', 'platform_ops']);
const SUPERVISOR_ROLE_CODES = new Set([ROLE_CODES.SUPERVISOR]);
const DISALLOWED_USER_ROLE_CODES = new Set([
  ROLE_CODES.VIEWER,
  ROLE_CODES.ZONE_ADMIN,
  ROLE_CODES.FACILITY_MANAGER,
]);
const TENANT_SCOPE_FIELD_MAP = {
  country: ['countryName'],
  state: ['countryName', 'stateName'],
  district: ['countryName', 'stateName', 'districtName'],
  city: ['countryName', 'stateName', 'districtName', 'cityName'],
  zone: ['countryName', 'stateName', 'districtName', 'cityName', 'zoneName'],
};
const LOCATION_NAME_KEYS = [
  'countryName',
  'stateName',
  'districtName',
  'cityName',
  'zoneName',
  'wardName',
];
const GEOGRAPHY_LIKE_ASSIGNMENT_LEVELS = new Set([
  'country',
  'state',
  'district',
  'city',
  'zone',
  'ward',
  'geography',
]);
const ALLOWED_ASSIGNMENT_LEVELS = new Set([
  'tenant',
  'country',
  'state',
  'district',
  'city',
  'zone',
  'ward',
  'geography',
  'facility',
  'toilet_unit',
]);

const unique = (values) => [...new Set(values)];
const normalizeRoleCodes = (roleCodes = []) =>
  uniqueNormalizedRoleCodes(roleCodes).map((roleCode) => normalizeRoleCode(roleCode));

const assertSupportedUserRoleCodes = (roleCodes = []) => {
  const disallowedRoleCodes = [...new Set((Array.isArray(roleCodes) ? roleCodes : [])
    .map((roleCode) => normalizeRoleCode(roleCode))
    .filter((roleCode) => DISALLOWED_USER_ROLE_CODES.has(roleCode)))];
  if (disallowedRoleCodes.length > 0) {
    throw new AppError('One or more role codes are no longer supported for assignment', 400, {
      code: 'ROLE_NOT_SUPPORTED',
      details: { roleCodes: disallowedRoleCodes },
    });
  }
};

const toStatus = (value, fallback = 'active') => {
  const normalized = String(value || fallback).toLowerCase();
  if (['active', 'inactive', 'locked'].includes(normalized)) return normalized;
  return fallback;
};

const normalizePhone = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeLocationValue = (value, limit = 180) => {
  if (value === undefined || value === null) return null;
  const normalized = sanitizeText(value, limit);
  return normalized || null;
};

const isSameLabel = (left, right) =>
  String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();

const isWorkerRole = (roleCodes = []) =>
  (Array.isArray(roleCodes) ? roleCodes : []).some(
    (roleCode) => normalizeRoleCode(roleCode) === ROLE_CODES.FIELD_WORKER,
  );

const isSupervisorRole = (roleCodes = []) =>
  (Array.isArray(roleCodes) ? roleCodes : []).some(
    (roleCode) => normalizeRoleCode(roleCode) === ROLE_CODES.SUPERVISOR,
  );

const actorRoleCodesFromRequest = (req = {}) =>
  uniqueNormalizedRoleCodes([
    ...(Array.isArray(req.user?.roleCodes) ? req.user.roleCodes : []),
    ...(Array.isArray(req.user?.allRoleCodes) ? req.user.allRoleCodes : []),
    req.user?.role,
  ]).map((roleCode) => normalizeRoleCode(roleCode));

const isDistrictAdminFieldWorkerContext = ({ req, roleCodes = [] }) => {
  if (req.user?.isSuperAdmin) return false;
  if (!isWorkerRole(roleCodes)) return false;
  const actorRoleCodes = actorRoleCodesFromRequest(req);
  return (
    String(req.user?.scopeLevel || '').trim().toLowerCase() === 'district' ||
    actorRoleCodes.includes(ROLE_CODES.DISTRICT_ADMIN)
  );
};

const assertDistrictAdminFieldWorkerPayload = ({ req, roleCodes = [], body = {}, phase = 'user' }) => {
  if (!isDistrictAdminFieldWorkerContext({ req, roleCodes })) return;

  if (body.geographyId) {
    throw new AppError('District Admin field worker must not submit geography scope', 400, {
      code: 'ROLE_SCOPE_VALIDATION_FAILED',
      details: { phase, field: 'geographyId' },
    });
  }
  if (String(body.cityName || '').trim()) {
    throw new AppError('District Admin field worker must not submit city scope', 400, {
      code: 'ROLE_SCOPE_VALIDATION_FAILED',
      details: { phase, field: 'cityName' },
    });
  }
  if (String(body.zoneName || '').trim()) {
    throw new AppError('District Admin field worker must not submit zone scope', 400, {
      code: 'ROLE_SCOPE_VALIDATION_FAILED',
      details: { phase, field: 'zoneName' },
    });
  }
  if (Array.isArray(body.assignments)) {
    for (const assignment of body.assignments) {
      if (!assignment || typeof assignment !== 'object') continue;
      if (assignment.geographyId || assignment.toiletUnitId) {
        throw new AppError('District Admin field worker must stay facility-scoped', 400, {
          code: 'ROLE_SCOPE_VALIDATION_FAILED',
          details: { phase, field: 'assignments' },
        });
      }
    }
  }
};

const LOCATION_LEVEL_TO_FIELD = {
  country: 'countryName',
  state: 'stateName',
  district: 'districtName',
  city: 'cityName',
  zone: 'zoneName',
  ward: 'wardName',
};

const randomReadableToken = (length = 5) =>
  Math.random()
    .toString(36)
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, length)
    .padEnd(length, 'X');

const normalizeUserIdCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 40);

const buildUserIdCodeCandidate = ({ tenantCode = null, fullName = null }) => {
  const tenantToken = String(tenantCode || 'USR')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4) || 'USR';
  const nameToken = String(fullName || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3);
  const randomToken = randomReadableToken(4);
  return normalizeUserIdCode(`${tenantToken}-${nameToken || 'MEM'}-${randomToken}`);
};

const resolveUniqueUserIdCode = async ({
  providedUserIdCode = null,
  tenantCode = null,
  fullName = null,
  excludeUserId = null,
  transaction = null,
}) => {
  let candidate = normalizeUserIdCode(providedUserIdCode) || buildUserIdCodeCandidate({ tenantCode, fullName });
  let attempt = 0;
  while (attempt < 25) {
    const duplicate = await PlatformUser.findOne({
      where: {
        user_id_code: candidate,
        ...(excludeUserId ? { id: { [Op.ne]: excludeUserId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    if (!duplicate) return candidate;
    candidate = buildUserIdCodeCandidate({ tenantCode, fullName });
    attempt += 1;
  }
  throw new AppError('Unable to generate unique userId', 409, {
    code: 'USER_ID_EXISTS',
  });
};

const mergeLocationNames = (...sources) => {
  const payload = {
    countryName: null,
    stateName: null,
    districtName: null,
    cityName: null,
    zoneName: null,
    wardName: null,
  };
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(payload)) {
      if (payload[key]) continue;
      const value = String(source[key] || '').trim();
      if (value) {
        payload[key] = value;
      }
    }
  }
  return payload;
};

const normalizeAssignmentLevel = (assignmentLevel, { geography, facility, toiletUnit }) => {
  const normalized = String(assignmentLevel || '')
    .trim()
    .toLowerCase();
  if (normalized && ALLOWED_ASSIGNMENT_LEVELS.has(normalized)) {
    return normalized;
  }
  if (toiletUnit) return 'toilet_unit';
  if (facility) return 'facility';
  if (geography) return 'geography';
  return 'tenant';
};

const toPersistedAssignmentLevel = (assignmentLevel) => {
  const normalized = String(assignmentLevel || '')
    .trim()
    .toLowerCase();

  // Backward compatibility:
  // Older databases may still carry the original worker_assignments enum
  // that only supports tenant|geography|facility|toilet_unit.
  // We keep zone/ward/city/etc scope via geography_id and persist the enum
  // value as "geography" so user creation does not fail on enum casts.
  if (GEOGRAPHY_LIKE_ASSIGNMENT_LEVELS.has(normalized)) {
    return 'geography';
  }

  if (ALLOWED_ASSIGNMENT_LEVELS.has(normalized)) {
    return normalized;
  }

  return sanitizeText(normalized, 40) || 'tenant';
};

const buildUserInclude = ({ roleCode } = {}) => {
  const roleInclude = {
    model: Role,
    attributes: ['id', 'code', 'name', 'description'],
    through: { attributes: ['tenant_id', 'geography_id'] },
    include: [{ model: Permission, attributes: ['id', 'code', 'name'] }],
  };

  if (roleCode) {
    roleInclude.where = { code: roleCode };
    roleInclude.required = true;
  }

  return [
    roleInclude,
    {
      model: Tenant,
      attributes: ['id', 'name', 'code', 'status'],
    },
  ];
};

const mapRoleMemberships = (user) => {
  return unique(
    (user.Roles || []).map((role) => {
      const tenantId = role?.UserRole?.tenant_id || user.tenant_id || null;
      const geographyId = role?.UserRole?.geography_id || user.geography_id || null;
      return JSON.stringify({
        roleCode: role.code,
        roleName: role.name,
        tenantId,
        geographyId,
        global: GLOBAL_ROLE_CODES.has(role.code),
      });
    })
  ).map((serialized) => JSON.parse(serialized));
};

const mapPermissions = (user) =>
  unique(
    (user.Roles || []).flatMap((role) =>
      (role.Permissions || []).map((permission) => permission.code)
    )
  );

const mapAssignment = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  supervisorUserId: row.supervisor_user_id || null,
  supervisorName: row.supervisor?.full_name || null,
  assignmentLevel: row.assignment_level,
  assignmentRole: row.assignment_role,
  status: row.status,
  geographyId: row.geography_id,
  geographyName: row.geography?.name || null,
  geographyLevel: row.geography?.level || null,
  facilityId: row.facility_id,
  facilityCode: row.facility?.code || null,
  facilityName: row.facility?.name || null,
  toiletUnitId: row.toilet_unit_id,
  toiletUnitCode: row.toiletUnit?.code || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const getAssignmentsByUserIds = async (userIds, { transaction } = {}) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();

  const rows = await WorkerAssignment.findAll({
    where: {
      user_id: { [Op.in]: userIds },
      status: 'active',
    },
    include: [
      {
        model: Geography,
        as: 'geography',
        attributes: ['id', 'name', 'level'],
      },
      {
        model: Facility,
        as: 'facility',
        attributes: ['id', 'code', 'name'],
      },
      {
        model: ToiletUnit,
        as: 'toiletUnit',
        attributes: ['id', 'code', 'unit_type'],
      },
      {
        model: PlatformUser,
        as: 'supervisor',
        attributes: ['id', 'full_name'],
      },
    ],
    order: [['created_at', 'DESC']],
    transaction,
  });

  const grouped = new Map();
  for (const row of rows) {
    const bucket = grouped.get(row.user_id) || [];
    bucket.push(mapAssignment(row));
    grouped.set(row.user_id, bucket);
  }
  return grouped;
};

const toPayload = (user, assignmentsByUserId = new Map()) => {
  const memberships = mapRoleMemberships(user);
  const permissions = mapPermissions(user);

  return {
    id: user.id,
    userIdCode: user.user_id_code || null,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    employeeCode: user.employee_code || null,
    remarks: user.remarks || null,
    tenantId: user.tenant_id,
    tenantName: user.Tenant?.name || null,
    tenantCode: user.Tenant?.code || null,
    geographyId: user.geography_id,
    countryName: user.country_name || null,
    stateName: user.state_name || null,
    districtName: user.district_name || null,
    cityName: user.city_name || null,
    zoneName: user.zone_name || null,
    wardName: user.ward_name || null,
    status: user.status,
    mustChangePassword: Boolean(user.must_change_password),
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    metadata: user.metadata || null,
    roleCodes: unique((user.Roles || []).map((role) => role.code)),
    roleNames: unique((user.Roles || []).map((role) => role.name)),
    permissions,
    memberships,
    assignments: assignmentsByUserId.get(user.id) || [],
  };
};

const isUserWithinScope = (req, user, assignments = []) => {
  if (req.user?.isSuperAdmin) return true;
  if (user.tenant_id !== req.user.tenantId) return false;

  const scopedGeographyIds = new Set(
    (Array.isArray(req.user?.scopeGeographyIds) ? req.user.scopeGeographyIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const scopedFacilityIds = new Set(
    (Array.isArray(req.user?.scopeFacilityIds) ? req.user.scopeFacilityIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  if (scopedGeographyIds.size === 0 && scopedFacilityIds.size === 0) {
    return true;
  }

  const userGeographyId = String(user.geography_id || '').trim();
  if (userGeographyId && scopedGeographyIds.has(userGeographyId)) {
    return true;
  }

  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const assignmentGeographyId = String(assignment?.geographyId || assignment?.geography_id || '').trim();
    if (assignmentGeographyId && scopedGeographyIds.has(assignmentGeographyId)) {
      return true;
    }
    const assignmentFacilityId = String(assignment?.facilityId || assignment?.facility_id || '').trim();
    if (assignmentFacilityId && scopedFacilityIds.has(assignmentFacilityId)) {
      return true;
    }
  }

  return false;
};

const assertUserScope = (req, user, assignments = []) => {
  if (!req.user.isSuperAdmin && user.tenant_id !== req.user.tenantId) {
    throw new AppError('Cannot access user outside your tenant', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  if (!isUserWithinScope(req, user, assignments)) {
    throw new AppError('Cannot access user outside your scope', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
};

const hasGlobalRole = (roleCodes) => roleCodes.some((code) => GLOBAL_ROLE_CODES.has(code));
const hasTenantRole = (roleCodes) => roleCodes.some((code) => !GLOBAL_ROLE_CODES.has(code));

const assertUuidInput = (value, field) => {
  if (!value) return;
  if (isUuid(value)) return;
  throw new AppError(`${field} must be a valid UUID`, 400, {
    code: 'VALIDATION_ERROR',
    details: { field },
  });
};

const ensureTenantExists = async (tenantId, { transaction } = {}) => {
  if (!tenantId) return null;
  assertUuidInput(tenantId, 'tenantId');
  const tenant = await Tenant.findByPk(tenantId, {
    attributes: [
      'id',
      'name',
      'code',
      'status',
      'scope_level',
      'country_name',
      'state_name',
      'district_name',
      'city_name',
      'zone_name',
      'root_geography_id',
    ],
    transaction,
  });
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  return tenant;
};

const ensureGeographyScope = async ({ geographyId, tenantId, transaction }) => {
  if (!geographyId) return null;
  assertUuidInput(geographyId, 'geographyId');
  const geography = await Geography.findByPk(geographyId, { transaction });
  if (!geography || geography.is_active === false) {
    throw new AppError('geographyId is outside tenant scope', 400, {
      code: 'GEOGRAPHY_SCOPE_INVALID',
    });
  }
  if (geography.tenant_id === tenantId) return geography;
  if (geography.tenant_id !== null) {
    throw new AppError('geographyId is outside tenant scope', 400, {
      code: 'GEOGRAPHY_SCOPE_INVALID',
    });
  }
  const [assignment, tenant] = await Promise.all([
    TenantGeographyAssignment.findOne({
      where: { tenant_id: tenantId, geography_id: geography.id, is_enabled: true },
      transaction,
    }),
    Tenant.findByPk(tenantId, { attributes: ['root_geography_id'], transaction }),
  ]);
  if (assignment) return geography;
  let cursorId = geography.id;
  let guard = 0;
  while (cursorId && guard < 12) {
    if (String(cursorId) === String(tenant?.root_geography_id || '')) return geography;
    const cursor = await Geography.findByPk(cursorId, { attributes: ['parent_id'], transaction });
    cursorId = cursor?.parent_id || null;
    guard += 1;
  }
  throw new AppError('geographyId is outside tenant scope', 400, {
    code: 'GEOGRAPHY_SCOPE_INVALID',
  });
};

const isGeographyInLiveScope = async (req, geography, { transaction = null } = {}) => {
  if (!geography) return true;
  if (req.user?.isSuperAdmin) return true;
  if (isGeographyInScope(req, geography.id)) return true;

  const scopedGeographyIds = uniqueIds(req.user?.scopeGeographyIds || []);
  if (scopedGeographyIds.length === 0) {
    return req.user?.scopeLevel === 'organization' || req.user?.scopeLevel === 'facility';
  }

  const scopedSet = new Set(scopedGeographyIds.map(String));
  if (geography.global_geography_id && scopedSet.has(String(geography.global_geography_id))) return true;
  let cursorId = geography.parent_id || null;
  let guard = 0;
  while (cursorId && guard < 12) {
    if (scopedSet.has(String(cursorId))) return true;
    const parent = await Geography.findByPk(cursorId, {
      attributes: ['id', 'parent_id', 'global_geography_id', 'master_geography_id'],
      transaction,
    });
    if (!parent) break;
    if ([parent.global_geography_id, parent.master_geography_id].filter(Boolean).some((id) => scopedSet.has(String(id)))) return true;
    cursorId = parent.parent_id || null;
    guard += 1;
  }
  return false;
};

const resolveImplicitGeographyScope = async ({ geographyId, tenantId, transaction }) => {
  if (!geographyId) return null;
  try {
    return await ensureGeographyScope({ geographyId, tenantId, transaction });
  } catch (error) {
    // Keep backward compatibility for legacy tenants that carry stale root/user geography links.
    if (error?.code === 'GEOGRAPHY_SCOPE_INVALID') {
      return null;
    }
    throw error;
  }
};

const resolveLocationNamesFromGeography = async ({ geographyId, transaction }) => {
  const location = {
    countryName: null,
    stateName: null,
    districtName: null,
    cityName: null,
    zoneName: null,
    wardName: null,
  };
  let cursorId = geographyId || null;
  let guard = 0;
  while (cursorId && guard < 12) {
    const geography = await Geography.findByPk(cursorId, {
      attributes: ['id', 'parent_id', 'level', 'name'],
      transaction,
    });
    if (!geography) break;
    const field = LOCATION_LEVEL_TO_FIELD[String(geography.level || '').toLowerCase()];
    if (field && !location[field]) {
      location[field] = geography.name;
    }
    cursorId = geography.parent_id || null;
    guard += 1;
  }
  return location;
};

const resolveTenantDefaultLocationNames = (tenant) => ({
  countryName: tenant?.country_name || null,
  stateName: tenant?.state_name || null,
  districtName: tenant?.district_name || null,
  cityName: tenant?.city_name || null,
  zoneName: tenant?.zone_name || null,
  wardName: null,
});

const resolveBodyLocationNames = (body = {}) => ({
  countryName: normalizeLocationValue(body.countryName),
  stateName: normalizeLocationValue(body.stateName),
  districtName: normalizeLocationValue(body.districtName),
  cityName: normalizeLocationValue(body.cityName),
  zoneName: normalizeLocationValue(body.zoneName),
  wardName: normalizeLocationValue(body.wardName),
});

const resolveDerivedLocationNames = async ({
  tenant,
  geographyId = null,
  body = {},
  transaction = null,
}) => {
  const bodyLocationNames = resolveBodyLocationNames(body);
  const geographyLocationNames = geographyId
    ? await resolveLocationNamesFromGeography({ geographyId, transaction })
    : {};
  const tenantLocationNames = resolveTenantDefaultLocationNames(tenant);
  const resolved = mergeLocationNames(
    geographyLocationNames,
    bodyLocationNames,
    tenantLocationNames,
  );
  return resolved;
};

const assertTenantLocationCompatibility = ({ tenant, locationNames = {} }) => {
  if (!tenant) return;

  const tenantLocationNames = resolveTenantDefaultLocationNames(tenant);
  const effectiveLocationNames = mergeLocationNames(locationNames, tenantLocationNames);
  const scopeLevel = String(tenant.scope_level || '').trim().toLowerCase();
  const requiredFields = TENANT_SCOPE_FIELD_MAP[scopeLevel] || [];
  for (const key of requiredFields) {
    const tenantValue = tenantLocationNames[key];
    const userValue = effectiveLocationNames[key];
    if (!tenantValue || !userValue) continue;
    if (!isSameLabel(tenantValue, userValue)) {
      throw new AppError(`User ${key} must match tenant ${key}`, 400, {
        code: 'LOCATION_SCOPE_INVALID',
      });
    }
  }

  const hasCompleteTenantBaseline =
    requiredFields.length === 0 ||
    requiredFields.every((field) => Boolean(String(tenantLocationNames[field] || '').trim()));
  if (!hasCompleteTenantBaseline) {
    return;
  }
  for (const field of requiredFields) {
    const value = String(effectiveLocationNames[field] || '').trim();
    if (value) continue;
    const tenantScopedValue = String(tenantLocationNames[field] || '').trim();
    // Legacy tenant records can be missing scope-level location labels.
    // Allow persona creation in those cases and rely on explicit geography/user mapping.
    if (!tenantScopedValue) continue;
    throw new AppError(`Missing required tenant-scoped location field: ${field}`, 400, {
      code: 'LOCATION_SCOPE_INVALID',
    });
  }
};

const ensureUniqueUserFields = async ({
  userId = null,
  email = null,
  phone = null,
  userIdCode = null,
  employeeCode = null,
  tenantId = null,
  transaction = null,
}) => {
  if (email) {
    const duplicateEmail = await PlatformUser.findOne({
      where: {
        email,
        ...(userId ? { id: { [Op.ne]: userId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    if (duplicateEmail) {
      throw new AppError('Email already exists', 409, { code: 'EMAIL_EXISTS' });
    }
  }

  if (phone) {
    const duplicatePhone = await PlatformUser.findOne({
      where: {
        phone,
        ...(userId ? { id: { [Op.ne]: userId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    if (duplicatePhone) {
      throw new AppError('Phone already exists', 409, { code: 'PHONE_EXISTS' });
    }
  }

  if (userIdCode) {
    const duplicateUserIdCode = await PlatformUser.findOne({
      where: {
        user_id_code: userIdCode,
        ...(userId ? { id: { [Op.ne]: userId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    if (duplicateUserIdCode) {
      throw new AppError('userId already exists', 409, { code: 'USER_ID_EXISTS' });
    }
  }

  if (tenantId && employeeCode) {
    const duplicateEmployeeCode = await PlatformUser.findOne({
      where: {
        tenant_id: tenantId,
        employee_code: employeeCode,
        ...(userId ? { id: { [Op.ne]: userId } } : {}),
      },
      attributes: ['id'],
      transaction,
    });
    if (duplicateEmployeeCode) {
      throw new AppError('employeeCode already exists in tenant scope', 409, {
        code: 'EMPLOYEE_CODE_EXISTS',
      });
    }
  }
};

const loadSupervisorCandidate = async ({
  supervisorUserId,
  tenantId,
  assignmentGeographyId = null,
  assignmentFacilityId = null,
  transaction = null,
}) => {
  if (!supervisorUserId) return null;
  assertUuidInput(supervisorUserId, 'supervisorUserId');
  const supervisor = await PlatformUser.findByPk(supervisorUserId, {
    include: [
      {
        model: Role,
        attributes: ['id', 'code', 'name'],
        through: { attributes: ['tenant_id', 'geography_id'] },
      },
      {
        model: WorkerAssignment,
        as: 'assignments',
        required: false,
        where: { status: 'active' },
        attributes: ['id', 'geography_id', 'facility_id', 'tenant_id'],
      },
    ],
    transaction,
  });
  if (!supervisor || supervisor.status !== 'active') {
    throw new AppError('Supervisor not found', 404, { code: 'SUPERVISOR_NOT_FOUND' });
  }
  if (String(supervisor.tenant_id || '') !== String(tenantId || '')) {
    throw new AppError('Supervisor is outside tenant scope', 400, {
      code: 'SUPERVISOR_SCOPE_INVALID',
    });
  }

  const supervisorRoleCodes = unique((supervisor.Roles || []).map((role) => normalizeRoleCode(role.code)));
  if (!supervisorRoleCodes.some((roleCode) => SUPERVISOR_ROLE_CODES.has(roleCode))) {
    throw new AppError('Selected supervisor user does not have supervisor role', 400, {
      code: 'SUPERVISOR_ROLE_INVALID',
    });
  }

  const assignmentRows = Array.isArray(supervisor.assignments) ? supervisor.assignments : [];
  const directFacilities = await Facility.findAll({
    where: {
      tenant_id: tenantId,
      supervisor_user_id: supervisor.id,
    },
    attributes: ['id', 'geography_id', 'zone_geography_id', 'ward_geography_id'],
    raw: true,
    transaction,
  });
  const directFacilityIds = new Set(
    directFacilities.map((row) => String(row.id || '').trim()).filter(Boolean)
  );
  const directGeographyIds = new Set(
    directFacilities
      .flatMap((row) => [row.geography_id, row.zone_geography_id, row.ward_geography_id])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const hasAnyExplicitSupervisorScope =
    assignmentRows.length > 0 ||
    directFacilities.length > 0 ||
    Boolean(String(supervisor.geography_id || '').trim());
  if (assignmentFacilityId) {
    const inFacilityScope =
      assignmentRows.some((row) => String(row.facility_id || '') === String(assignmentFacilityId)) ||
      directFacilityIds.has(String(assignmentFacilityId || '').trim()) ||
      String(supervisor.geography_id || '') === String(assignmentGeographyId || '') ||
      directGeographyIds.has(String(assignmentGeographyId || '').trim());
    if (!inFacilityScope && hasAnyExplicitSupervisorScope) {
      throw new AppError('Supervisor is not mapped to selected facility scope', 400, {
        code: 'SUPERVISOR_SCOPE_INVALID',
      });
    }
  } else if (assignmentGeographyId) {
    const inGeographyScope =
      assignmentRows.some((row) => String(row.geography_id || '') === String(assignmentGeographyId)) ||
      String(supervisor.geography_id || '') === String(assignmentGeographyId) ||
      directGeographyIds.has(String(assignmentGeographyId || '').trim());
    // Legacy data can have supervisors without explicit geography/facility rows.
    // Allow assignment in that case and rely on tenant-scoped role constraints.
    if (!inGeographyScope && hasAnyExplicitSupervisorScope) {
      throw new AppError('Supervisor is not mapped to selected geography scope', 400, {
        code: 'SUPERVISOR_SCOPE_INVALID',
      });
    }
  }

  return supervisor;
};

const ensureFacilityScope = async ({ facilityId, tenantId, transaction }) => {
  if (!facilityId) return null;
  assertUuidInput(facilityId, 'facilityId');
  const facility = await Facility.findByPk(facilityId, { transaction });
  if (!facility || facility.tenant_id !== tenantId) {
    throw new AppError('facilityId is outside tenant scope', 400, {
      code: 'FACILITY_SCOPE_INVALID',
    });
  }
  return facility;
};

const ensureToiletUnitScope = async ({ toiletUnitId, tenantId, transaction }) => {
  if (!toiletUnitId) return null;
  assertUuidInput(toiletUnitId, 'toiletUnitId');
  const toiletUnit = await ToiletUnit.findByPk(toiletUnitId, {
    include: [{ model: Facility, attributes: ['id', 'tenant_id', 'geography_id'] }],
    transaction,
  });
  if (!toiletUnit || toiletUnit.Facility?.tenant_id !== tenantId) {
    throw new AppError('toiletUnitId is outside tenant scope', 400, {
      code: 'TOILET_UNIT_SCOPE_INVALID',
    });
  }
  return toiletUnit;
};

const resolveRoles = async (roleCodes, { transaction } = {}) => {
  const roles = await Role.findAll({
    where: { code: { [Op.in]: roleCodes } },
    transaction,
  });
  if (roles.length !== roleCodes.length) {
    throw new AppError('One or more role codes are invalid', 400, {
      code: 'ROLE_NOT_FOUND',
    });
  }
  return roles;
};

const resolveCreateTenantId = ({ req, requestedTenantId, roleCodes }) => {
  if (!req.user.isSuperAdmin && requestedTenantId && requestedTenantId !== req.user.tenantId) {
    throw new AppError('Cannot assign users to another tenant', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }

  if (!req.user.isSuperAdmin && hasGlobalRole(roleCodes)) {
    throw new AppError('Only super admin can assign platform roles', 403, {
      code: 'ROLE_SCOPE_FORBIDDEN',
    });
  }

  const tenantId = req.user.isSuperAdmin ? requestedTenantId : req.user.tenantId;

  if (req.user.isSuperAdmin && hasTenantRole(roleCodes) && !tenantId) {
    throw new AppError('tenantId is required for tenant-scoped roles', 400, {
      code: 'TENANT_REQUIRED',
    });
  }

  if (req.user.isSuperAdmin && hasGlobalRole(roleCodes) && tenantId) {
    throw new AppError('Global platform roles cannot be tenant-scoped', 400, {
      code: 'INVALID_GLOBAL_ROLE_SCOPE',
    });
  }

  if (!req.user.isSuperAdmin && !tenantId) {
    throw new AppError('Authenticated user has no tenant scope', 403, {
      code: 'TENANT_CONTEXT_REQUIRED',
    });
  }

  return tenantId || null;
};

const normalizeAssignments = ({
  req,
  roleCodes,
  tenantId,
  bodyAssignments,
  geographyId,
  supervisorUserId = null,
}) => {
  const explicitAssignments = Array.isArray(bodyAssignments) ? bodyAssignments : [];
  if (explicitAssignments.length > 0) {
    return explicitAssignments;
  }

  const workerRole = isWorkerRole(roleCodes);
  const supervisorRole = isSupervisorRole(roleCodes);

  // Geography admin scope is carried by platform_users/user_roles. Avoid a
  // duplicate worker_assignment row, especially when the named hierarchy was
  // created during this request and is not yet present in the actor's token.
  if (getPersonaScopeLevel(roleCodes)) {
    return [];
  }

  if (tenantId && geographyId) {
    return [
      {
        geographyId,
        assignmentLevel: supervisorRole || workerRole ? 'zone' : 'geography',
        assignmentRole: roleCodes[0] || (workerRole ? 'worker' : 'user'),
        supervisorUserId: workerRole ? supervisorUserId || null : null,
      },
    ];
  }

  if (tenantId && hasTenantRole(roleCodes)) {
    return [
      {
        assignmentLevel: 'tenant',
        assignmentRole: roleCodes[0] || (workerRole ? 'worker' : 'user'),
        supervisorUserId: workerRole ? supervisorUserId || null : null,
      },
    ];
  }

  return [];
};

const replaceAssignments = async ({
  req,
  user,
  tenantId,
  roleCodes,
  assignments,
  actorUserId,
  transaction,
}) => {
  await WorkerAssignment.destroy({
    where: { user_id: user.id },
    transaction,
  });

  if (!tenantId || !Array.isArray(assignments) || assignments.length === 0) {
    return;
  }

  const rows = [];
  const supervisorById = new Map();

  for (const assignmentRaw of assignments) {
    const assignment = assignmentRaw || {};
    const geography = await ensureGeographyScope({
      geographyId: assignment.geographyId || null,
      tenantId,
      transaction,
    });
    const facility = await ensureFacilityScope({
      facilityId: assignment.facilityId || null,
      tenantId,
      transaction,
    });
    const toiletUnit = await ensureToiletUnitScope({
      toiletUnitId: assignment.toiletUnitId || null,
      tenantId,
      transaction,
    });

    if (geography && !(await isGeographyInLiveScope(req, geography, { transaction }))) {
      throw new AppError('assignment geography is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
    if (facility && !isFacilityInScope(req, facility.id)) {
      throw new AppError('assignment facility is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
    if (toiletUnit && !isFacilityInScope(req, toiletUnit.facility_id || null)) {
      throw new AppError('assignment toilet unit is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }

    const assignmentGeographyId = geography?.id || facility?.geography_id || null;
    const assignmentFacilityId = facility?.id || toiletUnit?.facility_id || null;
    const assignmentSupervisorUserId = assignment.supervisorUserId || null;
    let supervisor = null;
    if (assignmentSupervisorUserId) {
      if (!supervisorById.has(assignmentSupervisorUserId)) {
        const resolvedSupervisor = await loadSupervisorCandidate({
          supervisorUserId: assignmentSupervisorUserId,
          tenantId,
          assignmentGeographyId,
          assignmentFacilityId,
          transaction,
        });
        supervisorById.set(assignmentSupervisorUserId, resolvedSupervisor);
      }
      supervisor = supervisorById.get(assignmentSupervisorUserId);
    }

    const inferredLevel = normalizeAssignmentLevel(assignment.assignmentLevel, {
      geography,
      facility,
      toiletUnit,
    });
    if (
      geography &&
      GEOGRAPHY_LIKE_ASSIGNMENT_LEVELS.has(inferredLevel) &&
      inferredLevel !== 'geography' &&
      String(geography.level || '').trim().toLowerCase() !== inferredLevel
    ) {
      throw new AppError(`assignment geography must be a ${inferredLevel}`, 400, {
        code: 'ASSIGNMENT_GEOGRAPHY_LEVEL_INVALID',
      });
    }

    rows.push({
      tenant_id: tenantId,
      user_id: user.id,
      supervisor_user_id: supervisor?.id || null,
      geography_id: assignmentGeographyId,
      facility_id: assignmentFacilityId,
      toilet_unit_id: toiletUnit?.id || null,
      assignment_level: toPersistedAssignmentLevel(inferredLevel),
      assignment_role: sanitizeText(assignment.assignmentRole || roleCodes[0] || 'worker', 80),
      status: assignment.status === 'inactive' ? 'inactive' : 'active',
      created_by_user_id: actorUserId,
      updated_by_user_id: actorUserId,
    });
  }

  if (rows.length > 0) {
    await WorkerAssignment.bulkCreate(rows, { transaction });
  }
};

const listUsers = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = applyScopeToQuery(
    {},
    buildAccessContextFromUser(req?.user || {}),
    'tenant',
    { tenantKey: 'tenant_id' },
  );
  const q = sanitizeText(req.query.q || req.query.search || '', 120);
  if (q) {
    where[Op.or] = [
      { full_name: { [Op.iLike]: `%${q}%` } },
      { email: { [Op.iLike]: `%${q}%` } },
      { phone: { [Op.iLike]: `%${q}%` } },
      { employee_code: { [Op.iLike]: `%${q}%` } },
      { user_id_code: { [Op.iLike]: `%${q}%` } },
      { country_name: { [Op.iLike]: `%${q}%` } },
      { state_name: { [Op.iLike]: `%${q}%` } },
      { city_name: { [Op.iLike]: `%${q}%` } },
      { zone_name: { [Op.iLike]: `%${q}%` } },
    ];
  }

  if (req.query.status) {
    where.status = toStatus(req.query.status);
  }

  if (req.user.isSuperAdmin && req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  }

  const include = buildUserInclude({ roleCode: req.query.roleCode });

  const rows = await PlatformUser.findAll({
    where,
    include,
    order: [['created_at', 'DESC']],
    distinct: true,
  });

  const userIds = rows.map((user) => user.id);
  const assignmentsByUserId = await getAssignmentsByUserIds(userIds);
  const scopedRows = rows.filter((user) =>
    isUserWithinScope(req, user, assignmentsByUserId.get(user.id) || [])
  );
  const pagedRows = scopedRows.slice(offset, offset + limit);
  const count = scopedRows.length;

  return {
    items: pagedRows.map((user) => toPayload(user, assignmentsByUserId)),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getUserById = async (req) => {
  const user = await PlatformUser.findByPk(req.params.id, {
    include: buildUserInclude(),
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }
  const assignmentsByUserId = await getAssignmentsByUserIds([user.id]);
  const userAssignments = assignmentsByUserId.get(user.id) || [];
  assertUserScope(req, user, userAssignments);

  return toPayload(user, assignmentsByUserId);
};

const createUser = async (req) => {
  const roleCodes = normalizeRoleCodes(req.body.roleCodes || []);
  if (roleCodes.length === 0) {
    throw new AppError('roleCodes must be a non-empty array', 400, {
      code: 'VALIDATION_ERROR',
    });
  }
  assertSupportedUserRoleCodes(roleCodes);

  assertRoleDelegationAllowed({
    actorRoleCodes: req.user.roleCodes || req.user.allRoleCodes || [],
    targetRoleCodes: roleCodes,
    isSuperAdmin: Boolean(req.user.isSuperAdmin),
  });

  const requestedTenantId = req.body.tenantId || null;
  const tenantId = resolveCreateTenantId({
    req,
    requestedTenantId,
    roleCodes,
  });
  assertDistrictAdminFieldWorkerPayload({ req, roleCodes, body: req.body, phase: 'create' });
  const requestedGlobalGeographyId = req.body.globalGeographyId || null;
  const preActivatedTenantGeography = requestedGlobalGeographyId
    ? await resolveOrCreateTenantGeographyFromGlobal({
        tenantId,
        globalGeographyId: requestedGlobalGeographyId,
        createdBy: req.user.id,
        actor: req.user,
      })
    : null;

  let auditLogPayload = null;
  const response = await sequelize.transaction(async (transaction) => {
    let stage = 'resolve_roles';
    try {
      await resolveRoles(roleCodes, { transaction });
      stage = 'load_tenant';
      const tenant = await ensureTenantExists(tenantId, { transaction });
      const personaScopeLevel = getPersonaScopeLevel(roleCodes);
      stage = 'resolve_requested_geography';
      const requestedGeographyId = preActivatedTenantGeography?.id || req.body.geographyId || null;
      const fallbackTenantGeographyId = tenant?.root_geography_id || null;
      const enforceFacilityOnlyWorker = isDistrictAdminFieldWorkerContext({ req, roleCodes });
      const geographyId =
        (enforceFacilityOnlyWorker ? null : requestedGeographyId) ||
        (tenantId && hasTenantRole(roleCodes) ? fallbackTenantGeographyId : null);

      if (personaScopeLevel && !requestedGeographyId) {
        throw new AppError(`geographyId is required for ${personaScopeLevel} admin`, 400, {
          code: 'GEOGRAPHY_REQUIRED',
        });
      }

      stage = 'validate_geography_scope';
      const resolvedGeography = requestedGeographyId
        ? await ensureGeographyScope({ geographyId: requestedGeographyId, tenantId, transaction })
        : await resolveImplicitGeographyScope({ geographyId, tenantId, transaction });
      if (personaScopeLevel && resolvedGeography?.level !== personaScopeLevel) {
        throw new AppError(`${personaScopeLevel} admin must use a ${personaScopeLevel} geography`, 400, {
          code: 'GEOGRAPHY_LEVEL_INVALID',
        });
      }
      if (
        resolvedGeography &&
        (!personaScopeLevel || requestedGeographyId) &&
        !(await isGeographyInLiveScope(req, resolvedGeography, { transaction }))
      ) {
        throw new AppError('geographyId is outside actor scope', 403, {
          code: 'SCOPE_FORBIDDEN',
        });
      }

      const normalizedEmail = String(req.body.email).trim().toLowerCase();
      const normalizedPhone = normalizePhone(req.body.phone);
      const normalizedEmployeeCode = req.body.employeeCode
        ? sanitizeText(req.body.employeeCode, 64)
        : null;

      stage = 'resolve_user_code';
      const userIdCode = await resolveUniqueUserIdCode({
        providedUserIdCode: req.body.userId || req.body.userIdCode || null,
        tenantCode: tenant?.code || null,
        fullName: req.body.fullName,
        transaction,
      });

      stage = 'ensure_unique_fields';
      await ensureUniqueUserFields({
        email: normalizedEmail,
        phone: normalizedPhone,
        userIdCode,
        employeeCode: normalizedEmployeeCode,
        tenantId,
        transaction,
      });

      stage = 'resolve_location_names';
      const derivedLocationNames = await resolveDerivedLocationNames({
        tenant,
        geographyId: resolvedGeography?.id || null,
        body: req.body,
        transaction,
      });
      const resolvedLocationNames = normalizePersonaLocationNames({
        roleCodes,
        locationNames: derivedLocationNames,
      });
      assertPersonaLocationScope({
        actor: req.user,
        targetRoleCodes: roleCodes,
        locationNames: resolvedLocationNames,
        geographyLevel: resolvedGeography?.level || null,
      });
      if (!getPersonaScopeLevel(roleCodes)) {
        assertTenantLocationCompatibility({
          tenant,
          locationNames: resolvedLocationNames,
        });
      }

      const explicitSupervisorUserId = req.body.supervisorUserId || null;
      if (isWorkerRole(roleCodes) && tenantId && !explicitSupervisorUserId) {
        throw new AppError('supervisorUserId is required for worker role', 400, {
          code: 'SUPERVISOR_REQUIRED',
        });
      }

      const workerRole = isWorkerRole(roleCodes);
      let temporaryPassword = null;
      let passwordHash = null;
      let status = toStatus(req.body.status);
      let mustChangePassword = false;

      stage = 'prepare_password';
      if (workerRole) {
        temporaryPassword = generateTemporaryPassword();
        passwordHash = await hashPassword(temporaryPassword);
        status = 'active';
        mustChangePassword = true;
      } else {
        assertPasswordPolicy({ password: req.body.password });
        passwordHash = await hashPassword(req.body.password);
      }

      stage = 'create_platform_user';
      const user = await PlatformUser.create(
        {
          tenant_id: tenantId,
          geography_id: resolvedGeography?.id || null,
          full_name: sanitizeText(req.body.fullName, 180),
          email: normalizedEmail,
          phone: normalizedPhone,
          employee_code: normalizedEmployeeCode,
          user_id_code: userIdCode,
          remarks: req.body.remarks ? sanitizeText(req.body.remarks, 500) : null,
          country_name: resolvedLocationNames.countryName,
          state_name: resolvedLocationNames.stateName,
          district_name: resolvedLocationNames.districtName,
          city_name: resolvedLocationNames.cityName,
          zone_name: getPersonaScopeLevel(roleCodes) ? null : derivedLocationNames.zoneName,
          ward_name: getPersonaScopeLevel(roleCodes) ? null : resolvedLocationNames.wardName,
          password_hash: passwordHash,
          auth_provider: 'local',
          status,
          must_change_password: mustChangePassword,
          metadata: req.body.metadata || null,
        },
        { transaction }
      );

      stage = 'load_roles_for_membership';
      const roles = await resolveRoles(roleCodes, { transaction });
      stage = 'create_user_roles';
      for (const role of roles) {
        await UserRole.create(
          {
            user_id: user.id,
            role_id: role.id,
            tenant_id: tenantId,
            geography_id: resolvedGeography?.id || null,
          },
          { transaction }
        );
      }

      const assignments = normalizeAssignments({
        req,
        roleCodes,
        tenantId,
        bodyAssignments: req.body.assignments,
        geographyId: resolvedGeography?.id || null,
        supervisorUserId: explicitSupervisorUserId,
      });
      assertRoleScopeRequirements({
        roleCodes,
        geographyId: resolvedGeography?.id || null,
        assignments,
      });

      stage = 'replace_assignments';
      await replaceAssignments({
        req,
        user,
        tenantId,
        roleCodes,
        assignments,
        actorUserId: req.user.id,
        transaction,
      });

      stage = 'reload_created_user';
      const payload = await PlatformUser.findByPk(user.id, {
        include: buildUserInclude(),
        transaction,
      });

      stage = 'load_created_assignments';
      const assignmentsByUserId = await getAssignmentsByUserIds([user.id], {
        transaction,
      });

      auditLogPayload = {
        userId: user.id,
        tenantId: user.tenant_id,
        userIdCode,
        assignmentCount: assignments.length,
      };

      const nextResponse = toPayload(payload, assignmentsByUserId);
      if (temporaryPassword) {
        nextResponse.temporaryPassword = temporaryPassword;
      }
      return nextResponse;
    } catch (error) {
      if (error && !error.isOperational) {
        error.details = {
          ...(error.details || {}),
          createUserStage: stage,
        };
      }
      throw error;
    }
  });

  if (auditLogPayload) {
    await createAuditLog({
      req,
      action: 'users.create',
      entityType: 'platform_user',
      entityId: auditLogPayload.userId,
      tenantId: auditLogPayload.tenantId,
      details: {
        roleCodes,
        assignmentCount: auditLogPayload.assignmentCount,
        userIdCode: auditLogPayload.userIdCode,
      },
    });
  }

  return response;
};

const patchUser = async (req) => {
  const user = await PlatformUser.findByPk(req.params.id, {
    include: buildUserInclude(),
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }
  const existingAssignmentsByUserId = await getAssignmentsByUserIds([user.id]);
  const existingUserAssignments = existingAssignmentsByUserId.get(user.id) || [];
  assertUserScope(req, user, existingUserAssignments);

  const nextTenantId = req.user.isSuperAdmin
    ? req.body.tenantId !== undefined
      ? req.body.tenantId
      : user.tenant_id
    : user.tenant_id;

  if (!req.user.isSuperAdmin && req.body.tenantId && req.body.tenantId !== req.user.tenantId) {
    throw new AppError('Cannot move user to another tenant', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }

  return sequelize.transaction(async (transaction) => {
    const tenant = await ensureTenantExists(nextTenantId, { transaction });
    const existingRoleCodes = unique((user.Roles || []).map((role) => role.code));
    const prospectiveRoleCodes =
      Array.isArray(req.body.roleCodes) && req.body.roleCodes.length > 0
        ? normalizeRoleCodes(req.body.roleCodes)
        : existingRoleCodes;
    assertDistrictAdminFieldWorkerPayload({
      req,
      roleCodes: prospectiveRoleCodes,
      body: req.body,
      phase: 'patch',
    });
    const personaScopeLevel = getPersonaScopeLevel(prospectiveRoleCodes);
    const hasExplicitGeographyInput = req.body.geographyId !== undefined;
    const requestedGeographyId =
      hasExplicitGeographyInput ? req.body.geographyId || null : user.geography_id;
    const geographyId =
      requestedGeographyId ||
      (nextTenantId && hasTenantRole(unique((user.Roles || []).map((role) => role.code)))
        ? tenant?.root_geography_id || null
        : null);
    if (
      personaScopeLevel &&
      !requestedGeographyId &&
      (hasExplicitGeographyInput || Array.isArray(req.body.roleCodes))
    ) {
      throw new AppError(`geographyId is required for ${personaScopeLevel} admin`, 400, {
        code: 'GEOGRAPHY_REQUIRED',
      });
    }
    const resolvedGeography = hasExplicitGeographyInput
      ? await ensureGeographyScope({ geographyId: requestedGeographyId, tenantId: nextTenantId, transaction })
      : await resolveImplicitGeographyScope({ geographyId, tenantId: nextTenantId, transaction });
    if (personaScopeLevel && resolvedGeography && resolvedGeography.level !== personaScopeLevel) {
      throw new AppError(`${personaScopeLevel} admin must use a ${personaScopeLevel} geography`, 400, {
        code: 'GEOGRAPHY_LEVEL_INVALID',
      });
    }
    if (
      resolvedGeography &&
      (!personaScopeLevel || requestedGeographyId) &&
      !(await isGeographyInLiveScope(req, resolvedGeography, { transaction }))
    ) {
      throw new AppError('geographyId is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }

    const updates = {};
    if (req.body.fullName) updates.full_name = sanitizeText(req.body.fullName, 180);
    if (req.body.email !== undefined) {
      updates.email = String(req.body.email || '').trim().toLowerCase();
    }
    if (req.body.phone !== undefined) updates.phone = normalizePhone(req.body.phone);
    if (req.body.status) updates.status = toStatus(req.body.status, user.status);
    if (req.body.password) {
      assertPasswordPolicy({ password: req.body.password });
      updates.password_hash = await hashPassword(req.body.password);
      updates.must_change_password = false;
    }
    if (req.body.employeeCode !== undefined) {
      updates.employee_code = req.body.employeeCode
        ? sanitizeText(req.body.employeeCode, 64)
        : null;
    }
    if (req.body.userId !== undefined || req.body.userIdCode !== undefined) {
      updates.user_id_code = await resolveUniqueUserIdCode({
        providedUserIdCode: req.body.userId || req.body.userIdCode || null,
        tenantCode: tenant?.code || null,
        fullName: req.body.fullName || user.full_name,
        excludeUserId: user.id,
        transaction,
      });
    }
    if (req.body.remarks !== undefined) {
      updates.remarks = req.body.remarks ? sanitizeText(req.body.remarks, 500) : null;
    }
    if (req.body.metadata !== undefined) {
      updates.metadata = req.body.metadata;
    }
    if (req.body.geographyId !== undefined || req.body.roleCodes !== undefined) {
      updates.geography_id = resolvedGeography?.id || null;
    }
    if (req.user.isSuperAdmin && req.body.tenantId !== undefined) {
      updates.tenant_id = nextTenantId || null;
    }

    const nextEmail = updates.email !== undefined ? updates.email : user.email;
    const nextPhone = updates.phone !== undefined ? updates.phone : user.phone;
    const nextUserIdCode =
      updates.user_id_code !== undefined ? updates.user_id_code : user.user_id_code;
    const nextEmployeeCode =
      updates.employee_code !== undefined ? updates.employee_code : user.employee_code;

    await ensureUniqueUserFields({
      userId: user.id,
      email: nextEmail,
      phone: nextPhone,
      userIdCode: nextUserIdCode,
      employeeCode: nextEmployeeCode,
      tenantId: updates.tenant_id ?? user.tenant_id,
      transaction,
    });

    const shouldRefreshLocation =
      req.body.tenantId !== undefined ||
      req.body.geographyId !== undefined ||
      req.body.roleCodes !== undefined ||
      LOCATION_NAME_KEYS.some((key) => req.body[key] !== undefined);
    if (shouldRefreshLocation) {
      const derivedLocationNames = await resolveDerivedLocationNames({
        tenant,
        geographyId: resolvedGeography?.id || null,
        body: req.body,
        transaction,
      });
      const resolvedLocationNames = normalizePersonaLocationNames({
        roleCodes: prospectiveRoleCodes,
        locationNames: derivedLocationNames,
      });
      assertPersonaLocationScope({
        actor: req.user,
        targetRoleCodes: prospectiveRoleCodes,
        locationNames: resolvedLocationNames,
        geographyLevel: resolvedGeography?.level || null,
      });
      if (!getPersonaScopeLevel(prospectiveRoleCodes)) {
        assertTenantLocationCompatibility({
          tenant,
          locationNames: resolvedLocationNames,
        });
      }
      updates.country_name = resolvedLocationNames.countryName;
      updates.state_name = resolvedLocationNames.stateName;
      updates.district_name = resolvedLocationNames.districtName;
      updates.city_name = resolvedLocationNames.cityName;
      updates.zone_name = getPersonaScopeLevel(prospectiveRoleCodes)
        ? null
        : derivedLocationNames.zoneName;
      updates.ward_name = getPersonaScopeLevel(prospectiveRoleCodes)
        ? null
        : resolvedLocationNames.wardName;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date();
      await user.update(updates, { transaction });
    }
    const nextGeographyId = Object.prototype.hasOwnProperty.call(updates, 'geography_id')
      ? updates.geography_id
      : user.geography_id;

    let roleCodes = prospectiveRoleCodes;
    if (Array.isArray(req.body.roleCodes) && req.body.roleCodes.length > 0) {
      assertSupportedUserRoleCodes(roleCodes);
      if (!req.user.isSuperAdmin && hasGlobalRole(roleCodes)) {
        throw new AppError('Only super admin can assign platform roles', 403, {
          code: 'ROLE_SCOPE_FORBIDDEN',
        });
      }
      assertRoleDelegationAllowed({
        actorRoleCodes: req.user.roleCodes || req.user.allRoleCodes || [],
        targetRoleCodes: roleCodes,
        isSuperAdmin: Boolean(req.user.isSuperAdmin),
      });
      if (req.user.isSuperAdmin && hasTenantRole(roleCodes) && !nextTenantId) {
        throw new AppError('Cannot assign tenant-scoped role without tenant', 400, {
          code: 'TENANT_REQUIRED',
        });
      }
      if (req.user.isSuperAdmin && hasGlobalRole(roleCodes) && nextTenantId) {
        throw new AppError('Cannot assign global platform role to tenant-scoped user', 400, {
          code: 'INVALID_ROLE_SCOPE',
        });
      }

      const roles = await resolveRoles(roleCodes, { transaction });
      await UserRole.destroy({ where: { user_id: user.id }, transaction });
      await Promise.all(
        roles.map((role) =>
          UserRole.create(
            {
              user_id: user.id,
              role_id: role.id,
              tenant_id: nextTenantId,
              geography_id: nextGeographyId,
            },
            { transaction }
          )
        )
      );
    }

    const explicitSupervisorUserId =
      req.body.supervisorUserId !== undefined ? req.body.supervisorUserId || null : null;
    if (
      isWorkerRole(roleCodes) &&
      nextTenantId &&
      explicitSupervisorUserId === null &&
      req.body.assignments !== undefined
    ) {
      throw new AppError('supervisorUserId is required for worker role', 400, {
        code: 'SUPERVISOR_REQUIRED',
      });
    }

    const shouldReplaceAssignments =
      req.body.assignments !== undefined ||
      req.body.geographyId !== undefined ||
      req.body.clearAssignments === true ||
      req.body.supervisorUserId !== undefined;

    let nextAssignmentsForScopeValidation = null;
    if (shouldReplaceAssignments) {
      const assignments = req.body.clearAssignments
        ? []
        : normalizeAssignments({
            req,
            roleCodes,
            tenantId: nextTenantId,
            bodyAssignments: req.body.assignments,
            geographyId: nextGeographyId,
            supervisorUserId:
              explicitSupervisorUserId !== null
                ? explicitSupervisorUserId
                : req.body.supervisorUserId || null,
          });
      nextAssignmentsForScopeValidation = assignments;

      await replaceAssignments({
        req,
        user,
        tenantId: nextTenantId,
        roleCodes,
        assignments,
        actorUserId: req.user.id,
        transaction,
      });
    }

    const shouldValidateRoleScope =
      Array.isArray(req.body.roleCodes) ||
      req.body.geographyId !== undefined ||
      req.body.assignments !== undefined ||
      req.body.clearAssignments === true ||
      req.body.supervisorUserId !== undefined;

    if (shouldValidateRoleScope) {
      if (!nextAssignmentsForScopeValidation) {
        const existingAssignments = await WorkerAssignment.findAll({
          where: {
            user_id: user.id,
            status: 'active',
          },
          attributes: ['geography_id', 'facility_id', 'toilet_unit_id'],
          transaction,
        });
        nextAssignmentsForScopeValidation = existingAssignments.map((assignment) => ({
          geographyId: assignment.geography_id || null,
          facilityId: assignment.facility_id || null,
          toiletUnitId: assignment.toilet_unit_id || null,
        }));
      }
      assertRoleScopeRequirements({
        roleCodes,
        geographyId: nextGeographyId || null,
        assignments: nextAssignmentsForScopeValidation,
      });
    }

    const payload = await PlatformUser.findByPk(user.id, {
      include: buildUserInclude(),
      transaction,
    });
    const assignmentsByUserId = await getAssignmentsByUserIds([user.id], {
      transaction,
    });

    await createAuditLog({
      req,
      action: 'users.update',
      entityType: 'platform_user',
      entityId: user.id,
      tenantId: payload.tenant_id,
      details: {
        changedFields: Object.keys(req.body || {}),
      },
    });

    return toPayload(payload, assignmentsByUserId);
  });
};

const deleteUser = async (req) => {
  const user = await PlatformUser.findByPk(req.params.id, {
    include: buildUserInclude(),
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }

  const existingAssignmentsByUserId = await getAssignmentsByUserIds([user.id]);
  const existingUserAssignments = existingAssignmentsByUserId.get(user.id) || [];
  assertUserScope(req, user, existingUserAssignments);

  if (String(user.id) === String(req.user?.id || '')) {
    throw new AppError('You cannot delete your own account', 400, {
      code: 'SELF_DELETE_FORBIDDEN',
    });
  }

  const deletionReason = sanitizeText(req.body?.reason || 'Deleted via user management', 300);

  return sequelize.transaction(async (transaction) => {
    await WorkerAssignment.update(
      {
        status: 'inactive',
        updated_by_user_id: req.user.id,
        updated_at: new Date(),
      },
      {
        where: {
          user_id: user.id,
          status: 'active',
        },
        transaction,
      }
    );

    const nextMetadata =
      user.metadata && typeof user.metadata === 'object' && !Array.isArray(user.metadata)
        ? { ...user.metadata }
        : {};

    nextMetadata.deletedAt = new Date().toISOString();
    nextMetadata.deletedByUserId = req.user.id;
    nextMetadata.deletionReason = deletionReason;

    await user.update(
      {
        status: 'inactive',
        metadata: nextMetadata,
        updated_at: new Date(),
      },
      { transaction }
    );

    const payload = await PlatformUser.findByPk(user.id, {
      include: buildUserInclude(),
      transaction,
    });
    const assignmentsByUserId = await getAssignmentsByUserIds([user.id], {
      transaction,
    });

    await createAuditLog({
      req,
      action: 'users.delete',
      entityType: 'platform_user',
      entityId: user.id,
      tenantId: payload?.tenant_id || user.tenant_id,
      details: {
        mode: 'soft_delete',
        reason: deletionReason,
      },
    });

    return toPayload(payload, assignmentsByUserId);
  });
};

const listRoles = async () => {
  const roles = await Role.findAll({
    include: [{ model: Permission, attributes: ['id', 'code', 'name'] }],
    order: [['name', 'ASC']],
  });
  return roles.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    personaFamily: getPersonaFamily(role.code),
    requiredScopeType: getRequiredScopeType(role.code),
    permissionCodes: unique((role.Permissions || []).map((permission) => permission.code)),
  }));
};

const listPermissions = async () => {
  const permissions = await Permission.findAll({ order: [['name', 'ASC']] });
  return permissions.map((permission) => ({
    id: permission.id,
    code: permission.code,
    name: permission.name,
    description: permission.description,
  }));
};

const listSupervisors = async (req) => {
  const requestedTenantId = req.query.tenantId || null;
  const tenantId = req.user.isSuperAdmin ? requestedTenantId : req.user.tenantId;
  if (!tenantId) {
    throw new AppError('tenantId is required for supervisor lookup', 400, {
      code: 'TENANT_REQUIRED',
    });
  }
  if (!req.user.isSuperAdmin && String(tenantId) !== String(req.user.tenantId || '')) {
    throw new AppError('Cannot query supervisors outside your tenant scope', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }

  const geographyId = req.query.geographyId || null;
  const q = sanitizeText(req.query.q || req.query.search || '', 120);
  const where = {
    tenant_id: tenantId,
    status: 'active',
  };
  if (q) {
    where[Op.or] = [
      { full_name: { [Op.iLike]: `%${q}%` } },
      { email: { [Op.iLike]: `%${q}%` } },
      { user_id_code: { [Op.iLike]: `%${q}%` } },
      { phone: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const rows = await PlatformUser.findAll({
    where,
    include: [
      {
        model: Role,
        attributes: ['id', 'code', 'name'],
        through: { attributes: ['tenant_id', 'geography_id'] },
        where: { code: { [Op.in]: [...SUPERVISOR_ROLE_CODES] } },
        required: true,
      },
      {
        model: Tenant,
        attributes: ['id', 'name', 'code', 'status'],
      },
    ],
    order: [['full_name', 'ASC']],
    limit: 250,
  });

  const assignmentsByUserId = await getAssignmentsByUserIds(rows.map((row) => row.id));
  const filteredRows = rows.filter((row) => {
    const assignments = assignmentsByUserId.get(row.id) || [];
    if (!isUserWithinScope(req, row, assignments)) return false;
    if (!geographyId) return true;
    if (String(row.geography_id || '') === String(geographyId)) return true;
    return assignments.some((assignment) => String(assignment.geographyId || '') === String(geographyId));
  });

  return filteredRows.map((row) => {
    const assignments = assignmentsByUserId.get(row.id) || [];
    const zones = unique(
      assignments
        .filter((assignment) => ['zone', 'ward'].includes(String(assignment.geographyLevel || '').toLowerCase()))
        .map((assignment) => assignment.geographyName)
        .filter(Boolean),
    );
    return {
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      userIdCode: row.user_id_code || null,
      geographyId: row.geography_id || null,
      zoneName: row.zone_name || null,
      wardName: row.ward_name || null,
      roleCodes: unique((row.Roles || []).map((role) => role.code)),
      zones,
    };
  });
};

module.exports = {
  listUsers,
  getUserById,
  createUser,
  patchUser,
  deleteUser,
  listRoles,
  listPermissions,
  listSupervisors,
};
