const AppError = require('../errors/AppError');
const {
  GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES,
  ROLE_CODES,
  normalizeRoleCode,
} = require('./personaFamilies');
const {
  getPersonaScopeLevel,
  getRequiredLocationFields,
} = require('./personaLocationScope');

const hasScopedAssignment = (assignments = []) => {
  return (Array.isArray(assignments) ? assignments : []).some((assignment) => {
    if (!assignment || typeof assignment !== 'object') return false;
    return Boolean(assignment.geographyId || assignment.facilityId || assignment.toiletUnitId);
  });
};

const hasSupervisorGeographyScopedInput = ({ geographyId = null, assignments = [] }) => {
  if (geographyId) return true;
  return (Array.isArray(assignments) ? assignments : []).some((assignment) => {
    if (!assignment || typeof assignment !== 'object') return false;
    const assignmentLevel = String(assignment.assignmentLevel || '').trim().toLowerCase();
    if (!assignment.geographyId) return false;
    if (!assignmentLevel) return true;
    return ['zone', 'ward', 'geography'].includes(assignmentLevel);
  });
};

const collectRoleScopeValidationErrors = ({
  roleCodes = [],
  geographyId = null,
  assignments = [],
  locationNames = {},
}) => {
  const normalizedRoleCodes = [...new Set((Array.isArray(roleCodes) ? roleCodes : []).map(normalizeRoleCode).filter(Boolean))];
  const errors = [];

  const hasGeographyScopedRole = normalizedRoleCodes.some((roleCode) =>
    GEOGRAPHY_SCOPED_ADMIN_ROLE_CODES.has(roleCode)
  );
  const personaScopeLevel = getPersonaScopeLevel(normalizedRoleCodes);
  const hasCompleteNamedScope =
    Boolean(personaScopeLevel) &&
    getRequiredLocationFields(personaScopeLevel).every((field) =>
      Boolean(String(locationNames?.[field] || '').trim())
    );
  if (
    hasGeographyScopedRole &&
    !geographyId &&
    !hasScopedAssignment(assignments) &&
    !hasCompleteNamedScope
  ) {
    errors.push(
      'Scoped ops admin roles (country/state/district/city) require geographyId, location names, or scoped assignment'
    );
  }

  const hasSupervisorRole = normalizedRoleCodes.includes(ROLE_CODES.SUPERVISOR);
  const hasWorkerRole = normalizedRoleCodes.includes(ROLE_CODES.FIELD_WORKER);
  const hasGeographyScope = Boolean(geographyId);
  const hasScopedInput = hasGeographyScope || hasScopedAssignment(assignments);
  const hasSupervisorGeographyScope = hasSupervisorGeographyScopedInput({
    geographyId,
    assignments,
  });

  if (hasSupervisorRole && !hasSupervisorGeographyScope) {
    errors.push(
      'supervisor role requires zone/ward scope (geographyId or zone/ward geography assignment)'
    );
  }
  if (hasWorkerRole && !hasScopedInput) {
    errors.push(
      'field_worker role requires zone/ward/facility scope (geographyId or geographyId/facilityId/toiletUnitId assignment)'
    );
  }

  return errors;
};

const assertRoleScopeRequirements = ({
  roleCodes = [],
  geographyId = null,
  assignments = [],
  locationNames = {},
}) => {
  const errors = collectRoleScopeValidationErrors({
    roleCodes,
    geographyId,
    assignments,
    locationNames,
  });
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
