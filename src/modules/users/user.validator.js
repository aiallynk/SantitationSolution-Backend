const { isBlank, isUuid, parsePositiveInteger } = require('../../utils/validators');
const { collectRoleScopeValidationErrors } = require('../../core/rbac/roleScopeRules');

const ALLOWED_USER_STATUSES = new Set(['active', 'inactive', 'locked']);
const ALLOWED_ASSIGNMENT_LEVELS = new Set(['tenant', 'geography', 'facility', 'toilet_unit']);

const validateUuidField = (value, field, errors) => {
  if (value === undefined || value === null || value === '') return;
  if (!isUuid(value)) {
    errors.push(`${field} must be a valid UUID`);
  }
};

const hasValidAssignmentScope = (assignment = {}) => {
  const level = String(assignment.assignmentLevel || '').toLowerCase();
  if (level === 'tenant') return true;
  return Boolean(assignment.geographyId || assignment.facilityId || assignment.toiletUnitId);
};

const validateAssignments = (assignments, errors, prefix = 'assignments') => {
  if (assignments === undefined) return;
  if (!Array.isArray(assignments)) {
    errors.push(`${prefix} must be an array`);
    return;
  }

  assignments.forEach((assignment, index) => {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      errors.push(`${prefix}[${index}] must be an object`);
      return;
    }
    if (!hasValidAssignmentScope(assignment)) {
      errors.push(
        `${prefix}[${index}] must include at least one scope field (geographyId/facilityId/toiletUnitId) or assignmentLevel=tenant`
      );
    }
    if (
      assignment.assignmentLevel !== undefined &&
      !ALLOWED_ASSIGNMENT_LEVELS.has(String(assignment.assignmentLevel).toLowerCase())
    ) {
      errors.push(`${prefix}[${index}].assignmentLevel must be one of tenant|geography|facility|toilet_unit`);
    }
    if (
      assignment.status !== undefined &&
      !['active', 'inactive'].includes(String(assignment.status).toLowerCase())
    ) {
      errors.push(`${prefix}[${index}].status must be active or inactive`);
    }
    if (
      assignment.assignmentRole !== undefined &&
      String(assignment.assignmentRole).trim().length > 80
    ) {
      errors.push(`${prefix}[${index}].assignmentRole must be 80 characters or fewer`);
    }
    validateUuidField(assignment.geographyId, `${prefix}[${index}].geographyId`, errors);
    validateUuidField(assignment.facilityId, `${prefix}[${index}].facilityId`, errors);
    validateUuidField(assignment.toiletUnitId, `${prefix}[${index}].toiletUnitId`, errors);
  });
};

const validateUserListQuery = (req) => {
  const errors = [];
  if (Number.isNaN(parsePositiveInteger(req.query.page, 1))) {
    errors.push('page must be a positive integer');
  }
  if (Number.isNaN(parsePositiveInteger(req.query.limit, 20))) {
    errors.push('limit must be a positive integer');
  }
  if (req.query.status && !ALLOWED_USER_STATUSES.has(String(req.query.status).toLowerCase())) {
    errors.push('status must be one of active|inactive|locked');
  }
  if (req.query.roleCode !== undefined && isBlank(req.query.roleCode)) {
    errors.push('roleCode cannot be blank');
  }
  validateUuidField(req.query.tenantId, 'tenantId', errors);
  return errors;
};

const validateCreateUser = (req) => {
  const errors = [];
  if (isBlank(req.body.fullName)) errors.push('fullName is required');
  if (isBlank(req.body.email)) errors.push('email is required');
  if (isBlank(req.body.password)) errors.push('password is required');
  if (!isBlank(req.body.password) && String(req.body.password).length < 8) {
    errors.push('password must be at least 8 characters');
  }
  if (!Array.isArray(req.body.roleCodes) || req.body.roleCodes.length === 0) {
    errors.push('roleCodes must be a non-empty array');
  } else if (req.body.roleCodes.some((code) => isBlank(code))) {
    errors.push('roleCodes must not contain blank values');
  }
  if (req.body.employeeCode && String(req.body.employeeCode).trim().length > 64) {
    errors.push('employeeCode must be 64 characters or fewer');
  }
  if (req.body.status && !ALLOWED_USER_STATUSES.has(String(req.body.status).toLowerCase())) {
    errors.push('status must be one of active|inactive|locked');
  }
  validateUuidField(req.body.tenantId, 'tenantId', errors);
  validateUuidField(req.body.geographyId, 'geographyId', errors);
  validateAssignments(req.body.assignments, errors);
  if (Array.isArray(req.body.roleCodes) && req.body.roleCodes.length > 0) {
    errors.push(
      ...collectRoleScopeValidationErrors({
        roleCodes: req.body.roleCodes,
        geographyId: req.body.geographyId || null,
        assignments: req.body.assignments || [],
      })
    );
  }
  return errors;
};

const validatePatchUser = (req) => {
  const errors = [];
  if (req.body.password && String(req.body.password).length < 8) {
    errors.push('password must be at least 8 characters');
  }
  if (req.body.employeeCode && String(req.body.employeeCode).trim().length > 64) {
    errors.push('employeeCode must be 64 characters or fewer');
  }
  if (req.body.status && !ALLOWED_USER_STATUSES.has(String(req.body.status).toLowerCase())) {
    errors.push('status must be one of active|inactive|locked');
  }
  if (req.body.roleCodes !== undefined) {
    if (!Array.isArray(req.body.roleCodes) || req.body.roleCodes.length === 0) {
      errors.push('roleCodes must be a non-empty array when provided');
    } else if (req.body.roleCodes.some((code) => isBlank(code))) {
      errors.push('roleCodes must not contain blank values');
    }
  }
  if (req.body.metadata !== undefined && (typeof req.body.metadata !== 'object' || Array.isArray(req.body.metadata))) {
    errors.push('metadata must be an object');
  }
  if (req.body.clearAssignments !== undefined && typeof req.body.clearAssignments !== 'boolean') {
    errors.push('clearAssignments must be boolean');
  }
  validateUuidField(req.body.tenantId, 'tenantId', errors);
  validateUuidField(req.body.geographyId, 'geographyId', errors);
  validateAssignments(req.body.assignments, errors);
  if (Array.isArray(req.body.roleCodes) && req.body.roleCodes.length > 0) {
    errors.push(
      ...collectRoleScopeValidationErrors({
        roleCodes: req.body.roleCodes,
        geographyId: req.body.geographyId || null,
        assignments: req.body.assignments || [],
      })
    );
  }
  return errors;
};

module.exports = {
  validateUserListQuery,
  validateCreateUser,
  validatePatchUser,
};
