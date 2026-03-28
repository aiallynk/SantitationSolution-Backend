const { isBlank, parsePositiveInteger } = require('../../utils/validators');

const validateCreateInspection = (req) => {
  const errors = [];
  if (isBlank(req.body.facilityId)) errors.push('facilityId is required');
  if (isBlank(req.body.inspectionType)) errors.push('inspectionType is required');
  return errors;
};

const validateInspectionListQuery = (req) => {
  const errors = [];
  if (Number.isNaN(parsePositiveInteger(req.query.page, 1))) errors.push('page must be a positive integer');
  if (Number.isNaN(parsePositiveInteger(req.query.limit, 20))) errors.push('limit must be a positive integer');
  return errors;
};

const validateSubmitInspection = (req) => {
  const errors = [];
  if (isBlank(req.params.id)) errors.push('inspection id is required');
  return errors;
};

const validateReviewInspection = (req) => {
  const errors = [];
  if (isBlank(req.params.id)) errors.push('inspection id is required');
  const action = String(req.body.action || '').trim().toLowerCase();
  const allowedActions = new Set([
    'reviewed',
    'accepted',
    'rejected',
    'reinspection_required',
  ]);
  if (!allowedActions.has(action)) {
    errors.push('action must be one of reviewed|accepted|rejected|reinspection_required');
  }
  if (req.body.note && String(req.body.note).length > 800) {
    errors.push('note must be 800 characters or fewer');
  }
  return errors;
};

module.exports = {
  validateCreateInspection,
  validateInspectionListQuery,
  validateSubmitInspection,
  validateReviewInspection,
};
