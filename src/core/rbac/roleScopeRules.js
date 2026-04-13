const AppError = require('../errors/AppError');
const {
  GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES,
  ROLE_CODES,
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

  const hasFacilityManagerRole = normalizedRoleCodes.includes(ROLE_CODES.FACILITY_MANAGER);
  const hasSupervisorRole = normalizedRoleCodes.includes(ROLE_CODES.SUPERVISOR);
  const hasWorkerRole = normalizedRoleCodes.includes(ROLE_CODES.FIELD_WORKER);
  const hasFacilityAssignment = hasFacilityScopedAssignment(assignments);

  if (hasSupervisorRole && !hasScopedAssignment(assignments)) {
    errors.push(
      'supervisor role requires zone/ward or facility assignment (geographyId/facilityId/toiletUnitId)'
    );
  }
  if (hasWorkerRole && !hasScopedAssignment(assignments)) {
    errors.push(
      'field_worker role requires zone/ward or facility assignment (geographyId/facilityId/toiletUnitId)'
    );
  }
  if (hasFacilityManagerRole && !hasFacilityAssignment) {
    errors.push(
      'facility_manager role requires facility-scoped assignment (facilityId/toiletUnitId)'
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
