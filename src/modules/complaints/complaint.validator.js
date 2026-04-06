const { isBlank } = require('../../utils/validators');

const allowedPriorities = new Set(['low', 'medium', 'high', 'critical']);
const allowedSourceChannels = new Set([
  'field_app',
  'public_qr',
  'helpline',
  'admin_portal',
]);

const validateComplaintListQuery = (req) => {
  const errors = [];
  if (req.query.priority && !allowedPriorities.has(req.query.priority)) {
    errors.push('priority must be one of low|medium|high|critical');
  }
  if (req.query.sourceChannel && !allowedSourceChannels.has(String(req.query.sourceChannel))) {
    errors.push('sourceChannel must be one of field_app|public_qr|helpline|admin_portal');
  }
  return errors;
};

const validateComplaintCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.complaintType)) {
    errors.push('complaintType is required');
  }
  if (isBlank(req.body.description)) {
    errors.push('description is required');
  }
  if (req.body.priority && !allowedPriorities.has(req.body.priority)) {
    errors.push('priority must be one of low|medium|high|critical');
  }
  if (
    req.body.sourceChannel &&
    !allowedSourceChannels.has(String(req.body.sourceChannel))
  ) {
    errors.push('sourceChannel must be one of field_app|public_qr|helpline|admin_portal');
  }
  return errors;
};

const validateComplaintAssign = (req) => {
  const errors = [];
  if (req.body.assignedToUserId != null && typeof req.body.assignedToUserId !== 'string') {
    errors.push('assignedToUserId must be a string when provided');
  }
  return errors;
};

const validateComplaintDispatch = (req) => {
  const errors = [];
  if (req.body.message != null && typeof req.body.message !== 'string') {
    errors.push('message must be a string when provided');
  }
  return errors;
};

module.exports = {
  validateComplaintListQuery,
  validateComplaintCreate,
  validateComplaintAssign,
  validateComplaintDispatch,
};
