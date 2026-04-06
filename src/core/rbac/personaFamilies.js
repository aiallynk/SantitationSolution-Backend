const PersonaFamilies = {
  PLATFORM: 'PLATFORM',
  OPS_ADMIN: 'OPS_ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  READ_ONLY: 'READ_ONLY',
  FIELD_WORKER: 'FIELD_WORKER',
  LEGACY_COMPAT: 'LEGACY_COMPAT',
  UNKNOWN: 'UNKNOWN',
};

const ROLE_CODES = {
  SUPER_ADMIN: 'super_admin',
  PLATFORM_OPS: 'platform_ops',
  TENANT_ADMIN: 'tenant_admin',
  COUNTRY_ADMIN: 'country_admin',
  STATE_ADMIN: 'state_admin',
  DISTRICT_ADMIN: 'district_admin',
  CITY_ADMIN: 'city_admin',
  ZONE_ADMIN: 'zone_admin',
  FACILITY_MANAGER: 'facility_manager',
  SUPERVISOR: 'supervisor',
  FIELD_WORKER: 'field_worker',
  CONTRACTOR_MANAGER: 'contractor_manager',
  VIEWER: 'viewer',
  AUDITOR: 'auditor',
};

const PLATFORM_ROLE_CODES = new Set([ROLE_CODES.SUPER_ADMIN]);
const OPS_ADMIN_ROLE_CODES = new Set([
  ROLE_CODES.TENANT_ADMIN,
  ROLE_CODES.COUNTRY_ADMIN,
  ROLE_CODES.STATE_ADMIN,
  ROLE_CODES.DISTRICT_ADMIN,
  ROLE_CODES.CITY_ADMIN,
  ROLE_CODES.ZONE_ADMIN,
  ROLE_CODES.FACILITY_MANAGER,
]);
const SUPERVISOR_ROLE_CODES = new Set([ROLE_CODES.SUPERVISOR]);
const READ_ONLY_ROLE_CODES = new Set([ROLE_CODES.VIEWER, ROLE_CODES.AUDITOR]);
const FIELD_WORKER_ROLE_CODES = new Set([ROLE_CODES.FIELD_WORKER]);
const LEGACY_COMPAT_ROLE_CODES = new Set([ROLE_CODES.PLATFORM_OPS, ROLE_CODES.CONTRACTOR_MANAGER]);

const GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES = new Set([
  ROLE_CODES.COUNTRY_ADMIN,
  ROLE_CODES.STATE_ADMIN,
  ROLE_CODES.DISTRICT_ADMIN,
  ROLE_CODES.CITY_ADMIN,
  ROLE_CODES.ZONE_ADMIN,
]);
const FACILITY_SCOPED_ADMIN_ROLE_CODES = new Set([ROLE_CODES.FACILITY_MANAGER]);

const normalizeRoleCode = (roleCode) => String(roleCode || '').trim().toLowerCase();

const getPersonaFamily = (roleCode) => {
  const normalizedRoleCode = normalizeRoleCode(roleCode);
  if (!normalizedRoleCode) return PersonaFamilies.UNKNOWN;
  if (PLATFORM_ROLE_CODES.has(normalizedRoleCode)) return PersonaFamilies.PLATFORM;
  if (OPS_ADMIN_ROLE_CODES.has(normalizedRoleCode)) return PersonaFamilies.OPS_ADMIN;
  if (SUPERVISOR_ROLE_CODES.has(normalizedRoleCode)) return PersonaFamilies.SUPERVISOR;
  if (READ_ONLY_ROLE_CODES.has(normalizedRoleCode)) return PersonaFamilies.READ_ONLY;
  if (FIELD_WORKER_ROLE_CODES.has(normalizedRoleCode)) return PersonaFamilies.FIELD_WORKER;
  if (LEGACY_COMPAT_ROLE_CODES.has(normalizedRoleCode)) return PersonaFamilies.LEGACY_COMPAT;
  return PersonaFamilies.UNKNOWN;
};

const isPlatformPersona = (roleCode) => getPersonaFamily(roleCode) === PersonaFamilies.PLATFORM;
const isOpsAdminFamily = (roleCode) => getPersonaFamily(roleCode) === PersonaFamilies.OPS_ADMIN;
const isSupervisor = (roleCode) => getPersonaFamily(roleCode) === PersonaFamilies.SUPERVISOR;
const isReadOnlyFamily = (roleCode) => getPersonaFamily(roleCode) === PersonaFamilies.READ_ONLY;
const isFieldWorker = (roleCode) => getPersonaFamily(roleCode) === PersonaFamilies.FIELD_WORKER;
const isLegacyCompatRole = (roleCode) => getPersonaFamily(roleCode) === PersonaFamilies.LEGACY_COMPAT;

const getRequiredScopeType = (roleCode) => {
  const normalizedRoleCode = normalizeRoleCode(roleCode);
  if (GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES.has(normalizedRoleCode)) return 'geography';
  if (FACILITY_SCOPED_ADMIN_ROLE_CODES.has(normalizedRoleCode)) return 'facility';
  return 'none';
};

module.exports = {
  PersonaFamilies,
  ROLE_CODES,
  PLATFORM_ROLE_CODES,
  OPS_ADMIN_ROLE_CODES,
  SUPERVISOR_ROLE_CODES,
  READ_ONLY_ROLE_CODES,
  FIELD_WORKER_ROLE_CODES,
  LEGACY_COMPAT_ROLE_CODES,
  GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES,
  FACILITY_SCOPED_ADMIN_ROLE_CODES,
  normalizeRoleCode,
  getPersonaFamily,
  isPlatformPersona,
  isOpsAdminFamily,
  isSupervisor,
  isReadOnlyFamily,
  isFieldWorker,
  isLegacyCompatRole,
  getRequiredScopeType,
};
