const { isBlank } = require('../../utils/validators');

const allowedPriorities = new Set(['low', 'medium', 'high', 'critical']);

const validateComplaintListQuery = (req) => {
  const errors = [];
  if (req.query.priority && !allowedPriorities.has(req.query.priority)) {
    errors.push('priority must be one of low|medium|high|critical');
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
  return errors;
};

const validateComplaintAssign = (req) => {
  const errors = [];
  if (req.body.assignedToUserId != null && typeof req.body.assignedToUserId !== 'string') {
    errors.push('assignedToUserId must be a string when provided');
  }
  return errors;
};

module.exports = {
  validateComplaintListQuery,
  validateComplaintCreate,
  validateComplaintAssign,
};
