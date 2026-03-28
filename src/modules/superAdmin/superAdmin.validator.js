const { isBlank, inEnum, parsePositiveInteger } = require('../../utils/validators');

const validateTenantProvision = (req) => {
  const errors = [];
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.code)) errors.push('code is required');
  if (req.body.countryCode !== undefined && !isBlank(req.body.countryCode) && String(req.body.countryCode).length > 10) {
    errors.push('countryCode must be 10 characters or fewer');
  }
  if (req.body.metadata !== undefined && (typeof req.body.metadata !== 'object' || Array.isArray(req.body.metadata))) {
    errors.push('metadata must be an object when provided');
  }
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['active', 'inactive'])) {
    errors.push('status must be active or inactive');
  }
  if (req.body.plan !== undefined && isBlank(req.body.plan)) {
    errors.push('plan must be a non-empty string when provided');
  }
  if (req.body.admin !== undefined) {
    if (typeof req.body.admin !== 'object' || Array.isArray(req.body.admin) || req.body.admin === null) {
      errors.push('admin must be an object');
    } else {
      if (isBlank(req.body.admin.fullName)) errors.push('admin.fullName is required when admin onboarding is provided');
      if (isBlank(req.body.admin.email)) errors.push('admin.email is required when admin onboarding is provided');
      if (isBlank(req.body.admin.password)) errors.push('admin.password is required when admin onboarding is provided');
      if (!isBlank(req.body.admin.password) && String(req.body.admin.password).length < 8) {
        errors.push('admin.password must be at least 8 characters');
      }
    }
  }
  return errors;
};

const validateTenantPatch = (req) => {
  const errors = [];
  if (req.body.name !== undefined && isBlank(req.body.name)) {
    errors.push('name must be a non-empty string when provided');
  }
  if (req.body.code !== undefined && isBlank(req.body.code)) {
    errors.push('code must be a non-empty string when provided');
  }
  if (req.body.countryCode !== undefined && !isBlank(req.body.countryCode) && String(req.body.countryCode).length > 10) {
    errors.push('countryCode must be 10 characters or fewer');
  }
  if (req.body.metadata !== undefined && (typeof req.body.metadata !== 'object' || Array.isArray(req.body.metadata))) {
    errors.push('metadata must be an object when provided');
  }
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['active', 'inactive'])) {
    errors.push('status must be active or inactive');
  }
  if (req.body.plan !== undefined && isBlank(req.body.plan)) {
    errors.push('plan must be a non-empty string when provided');
  }
  return errors;
};

const validateFeatureFlagsPatch = (req) => {
  const errors = [];
  if (req.body.flags !== undefined && (typeof req.body.flags !== 'object' || Array.isArray(req.body.flags))) {
    errors.push('flags must be an object');
  }
  if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    errors.push('enabled must be boolean');
  }
  return errors;
};

const validateListQuery = (req) => {
  const errors = [];
  if (req.query.limit !== undefined && Number.isNaN(parsePositiveInteger(req.query.limit, 1))) {
    errors.push('limit must be a positive integer');
  }
  if (req.query.page !== undefined && Number.isNaN(parsePositiveInteger(req.query.page, 1))) {
    errors.push('page must be a positive integer');
  }
  return errors;
};

const validateApprovalCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.category)) errors.push('category is required');
  if (isBlank(req.body.entityType)) errors.push('entityType is required');
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['pending', 'approved', 'rejected', 'cancelled'])) {
    errors.push('status is invalid');
  }
  return errors;
};

const validateApprovalDecision = (req) => {
  const errors = [];
  if (!inEnum(req.body.status, ['approved', 'rejected', 'cancelled'])) {
    errors.push('status must be approved, rejected, or cancelled');
  }
  return errors;
};

const validateProjectCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.code)) errors.push('code is required');
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['planned', 'active', 'on_hold', 'completed', 'cancelled'])) {
    errors.push('status is invalid');
  }
  return errors;
};

const validateSupportTicketCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.subject)) errors.push('subject is required');
  if (isBlank(req.body.description)) errors.push('description is required');
  if (!isBlank(req.body.severity) && !inEnum(req.body.severity, ['low', 'medium', 'high', 'critical'])) {
    errors.push('severity is invalid');
  }
  return errors;
};

const validateSupportTicketPatch = (req) => {
  const errors = [];
  if (req.body.status && !inEnum(req.body.status, ['open', 'in_progress', 'resolved', 'closed'])) {
    errors.push('status is invalid');
  }
  if (req.body.severity && !inEnum(req.body.severity, ['low', 'medium', 'high', 'critical'])) {
    errors.push('severity is invalid');
  }
  return errors;
};

const validateIntegrationUpsert = (req) => {
  const errors = [];
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.configType)) errors.push('configType is required');
  if (req.body.configJson === undefined || req.body.configJson === null || typeof req.body.configJson !== 'object') {
    errors.push('configJson must be an object');
  }
  if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    errors.push('enabled must be boolean');
  }
  return errors;
};

const validateReleaseCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.version)) errors.push('version is required');
  if (isBlank(req.body.environment)) errors.push('environment is required');
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['planned', 'running', 'success', 'failed', 'rolled_back'])) {
    errors.push('status is invalid');
  }
  return errors;
};

const validateBackupCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.backupType)) errors.push('backupType is required');
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['queued', 'running', 'completed', 'failed'])) {
    errors.push('status is invalid');
  }
  return errors;
};

const validateSyncFailurePatch = (req) => {
  const errors = [];
  if (!inEnum(req.body.status, ['resolved', 'ignored', 'open'])) {
    errors.push('status is invalid');
  }
  return errors;
};

module.exports = {
  validateTenantProvision,
  validateTenantPatch,
  validateFeatureFlagsPatch,
  validateListQuery,
  validateApprovalCreate,
  validateApprovalDecision,
  validateProjectCreate,
  validateSupportTicketCreate,
  validateSupportTicketPatch,
  validateIntegrationUpsert,
  validateReleaseCreate,
  validateBackupCreate,
  validateSyncFailurePatch,
};
