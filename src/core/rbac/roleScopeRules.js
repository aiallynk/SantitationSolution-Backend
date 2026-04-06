const AppError = require('../errors/AppError');
const {
  FACILITY_SCOPED_ADMIN_ROLE_CODES,
  GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES,
  normalizeRoleCode,
} = require('./personaFamilies');

const hasScopedAssignment = (assignments = []) => {
  return (Array.isArray(assignments) ? assignments : []).some((assignment) => {
    if (!assignment || typeof assignment !== 'object') return false;
    return Boolean(assignment.geographyId || assignment.facilityId || assignment.toiletUnitId);
  });
};

const hasFacilityScopedAssignment = (assignments = []) => {
  return (Array.isArray(assignments) ? assignments : []).some((assignment) => {
    if (!assignment || typeof assignment !== 'object') return false;
    return Boolean(assignment.facilityId || assignment.toiletUnitId);
  });
};

const collectRoleScopeValidationErrors = ({ roleCodes = [], geographyId = null, assignments = [] }) => {
  const normalizedRoleCodes = [...new Set((Array.isArray(roleCodes) ? roleCodes : []).map(normalizeRoleCode).filter(Boolean))];
  const errors = [];

  const hasGeographyScopedRole = normalizedRoleCodes.some((roleCode) =>
    GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES.has(roleCode)
  );
  if (hasGeographyScopedRole && !geographyId && !hasScopedAssignment(assignments)) {
    errors.push(
      'Scoped ops admin roles (country/state/district/city/zone) require geographyId or scoped assignment'
    );
  }

  const hasFacilityScopedRole = normalizedRoleCodes.some((roleCode) =>
    FACILITY_SCOPED_ADMIN_ROLE_CODES.has(roleCode)
  );
  // Keep legacy compatibility: allow geographyId fallback when facility assignment is missing.
  if (hasFacilityScopedRole && !hasFacilityScopedAssignment(assignments) && !geographyId) {
    errors.push(
      'facility_manager role requires facility-scoped assignment (facilityId/toiletUnitId) or geographyId for legacy compatibility'
    );
  }

  return errors;
};

const assertRoleScopeRequirements = ({ roleCodes = [], geographyId = null, assignments = [] }) => {
  const errors = collectRoleScopeValidationErrors({ roleCodes, geographyId, assignments });
  if (errors.length > 0) {
    throw new AppError('Role scope validation failed', 400, {
      code: 'ROLE_SCOPE_VALIDATION_FAILED',
      details: { errors },
    });
  }
};

module.exports = {
  collectRoleScopeValidationErrors,
  assertRoleScopeRequirements,
};
