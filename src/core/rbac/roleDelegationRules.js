const AppError = require('../errors/AppError');
const { ROLE_CODES, normalizeRoleCode } = require('./personaFamilies');

const GLOBAL_ROLE_CODES = new Set([ROLE_CODES.SUPER_ADMIN, ROLE_CODES.PLATFORM_OPS]);

const ROLE_DELEGATION_RANK = new Map([
  [ROLE_CODES.SUPER_ADMIN, 0],
  [ROLE_CODES.PLATFORM_OPS, 5],
  [ROLE_CODES.TENANT_ADMIN, 10],
  [ROLE_CODES.COUNTRY_ADMIN, 20],
  [ROLE_CODES.STATE_ADMIN, 30],
  [ROLE_CODES.DISTRICT_ADMIN, 40],
  [ROLE_CODES.CITY_ADMIN, 50],
  [ROLE_CODES.ZONE_ADMIN, 60],
  [ROLE_CODES.FACILITY_MANAGER, 70],
  [ROLE_CODES.SUPERVISOR, 80],
  [ROLE_CODES.FIELD_WORKER, 90],
  [ROLE_CODES.VIEWER, 90],
  [ROLE_CODES.AUDITOR, 90],
  [ROLE_CODES.CONTRACTOR_MANAGER, 95],
]);

const uniqueNormalizedRoleCodes = (roleCodes = []) => {
  return [...new Set((Array.isArray(roleCodes) ? roleCodes : []).map(normalizeRoleCode).filter(Boolean))];
};

const collectRoleDelegationErrors = ({
  actorRoleCodes = [],
  targetRoleCodes = [],
  isSuperAdmin = false,
}) => {
  const normalizedTargets = uniqueNormalizedRoleCodes(targetRoleCodes);
  if (normalizedTargets.length === 0) return [];
  if (isSuperAdmin) return [];

  const normalizedActors = uniqueNormalizedRoleCodes(actorRoleCodes);
  const actorRanks = normalizedActors
    .filter((code) => !GLOBAL_ROLE_CODES.has(code))
    .map((code) => ROLE_DELEGATION_RANK.get(code))
    .filter((rank) => Number.isFinite(rank));

  if (actorRanks.length === 0) {
    return ['Current persona does not have delegated user-role assignment scope'];
  }

  const actorMinRank = Math.min(...actorRanks);
  const blockedRoleCodes = normalizedTargets.filter((targetCode) => {
    if (GLOBAL_ROLE_CODES.has(targetCode)) return true;
    const targetRank = ROLE_DELEGATION_RANK.get(targetCode);
    if (!Number.isFinite(targetRank)) return true;
    return targetRank <= actorMinRank;
  });

  if (blockedRoleCodes.length === 0) {
    return [];
  }

  return [`Cannot assign role(s) outside your persona scope: ${blockedRoleCodes.join(', ')}`];
};

const assertRoleDelegationAllowed = ({
  actorRoleCodes = [],
  targetRoleCodes = [],
  isSuperAdmin = false,
}) => {
  const errors = collectRoleDelegationErrors({
    actorRoleCodes,
    targetRoleCodes,
    isSuperAdmin,
  });
  if (errors.length > 0) {
    throw new AppError('Role delegation policy failed', 403, {
      code: 'ROLE_DELEGATION_FORBIDDEN',
      details: { errors },
    });
  }
};

module.exports = {
  GLOBAL_ROLE_CODES,
  ROLE_DELEGATION_RANK,
  uniqueNormalizedRoleCodes,
  collectRoleDelegationErrors,
  assertRoleDelegationAllowed,
};
