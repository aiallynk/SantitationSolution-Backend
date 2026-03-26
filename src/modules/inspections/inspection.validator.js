const {
  isBlank,
  parseOptionalNumber,
  parsePositiveInteger,
  inEnum,
} = require('../../utils/validators');

const INSPECTION_STATUSES = ['pending', 'processing', 'completed', 'failed'];
const INSPECTION_SEVERITIES = ['critical', 'poor', 'moderate', 'good', 'excellent'];

const validateSubmitInspection = (req) => {
  const errors = [];
  const { body, files } = req;

  if (!files || !Array.isArray(files.beforeImage) || files.beforeImage.length === 0) {
    errors.push('beforeImage is required');
  }

  if (!files || !Array.isArray(files.afterImage) || files.afterImage.length === 0) {
    errors.push('afterImage is required');
  }

  const requiredFields = [
    'toiletCode',
    'toiletName',
    'city',
    'ward',
    'zone',
    'sector',
  ];

  requiredFields.forEach((field) => {
    const value = body[field];
    if (isBlank(value)) {
      errors.push(`${field} is required`);
    } else if (String(value).trim().length > 120) {
      errors.push(`${field} must be 120 characters or less`);
    }
  });

  if (body.remarks && String(body.remarks).trim().length > 500) {
    errors.push('remarks must be 500 characters or less');
  }

  const latitude = parseOptionalNumber(body.latitude);
  const longitude = parseOptionalNumber(body.longitude);

  if (Number.isNaN(latitude)) {
    errors.push('latitude must be a valid number');
  } else if (latitude !== null && (latitude < -90 || latitude > 90)) {
    errors.push('latitude must be between -90 and 90');
  }

  if (Number.isNaN(longitude)) {
    errors.push('longitude must be a valid number');
  } else if (longitude !== null && (longitude < -180 || longitude > 180)) {
    errors.push('longitude must be between -180 and 180');
  }

  return errors;
};

const validateInspectionListQuery = (req) => {
  const errors = [];
  const { status, severity, page, limit, zone, ward } = req.query;

  if (!inEnum(status, INSPECTION_STATUSES)) {
    errors.push('status must be one of pending, processing, completed, failed');
  }

  if (!inEnum(severity, INSPECTION_SEVERITIES)) {
    errors.push('severity must be one of critical, poor, moderate, good, excellent');
  }

  const parsedPage = parsePositiveInteger(page, 1);
  const parsedLimit = parsePositiveInteger(limit, 20);

  if (Number.isNaN(parsedPage)) {
    errors.push('page must be a positive integer');
  }

  if (Number.isNaN(parsedLimit)) {
    errors.push('limit must be a positive integer');
  } else if (parsedLimit > 100) {
    errors.push('limit cannot be greater than 100');
  }

  if (zone && String(zone).trim().length > 80) {
    errors.push('zone must be 80 characters or less');
  }

  if (ward && String(ward).trim().length > 80) {
    errors.push('ward must be 80 characters or less');
  }

  return errors;
};

const validateRecentQuery = (req) => {
  const errors = [];
  const { limit } = req.query;

  const parsedLimit = parsePositiveInteger(limit, 10);
  if (Number.isNaN(parsedLimit)) {
    errors.push('limit must be a positive integer');
  } else if (parsedLimit > 50) {
    errors.push('limit cannot be greater than 50');
  }

  return errors;
};

const validateInspectionIdParam = (req) => {
  const errors = [];
  const inspectionId = parsePositiveInteger(req.params.id);

  if (Number.isNaN(inspectionId)) {
    errors.push('id must be a positive integer');
  }

  return errors;
};

module.exports = {
  validateSubmitInspection,
  validateInspectionListQuery,
  validateRecentQuery,
  validateInspectionIdParam,
};
