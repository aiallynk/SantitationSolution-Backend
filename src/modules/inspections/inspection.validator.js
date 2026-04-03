const { isBlank, parsePositiveInteger } = require('../../utils/validators');

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

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
  if (req.body.clientSubmissionId && String(req.body.clientSubmissionId).length > 120) {
    errors.push('clientSubmissionId must be 120 characters or fewer');
  }
  if (req.body.submittedAt && Number.isNaN(Date.parse(req.body.submittedAt))) {
    errors.push('submittedAt must be a valid ISO date');
  }
  return errors;
};

const validateCreateMediaUploadSession = (req) => {
  const errors = [];
  if (isBlank(req.params.id)) errors.push('inspection id is required');
  if (!Array.isArray(req.body.images) || req.body.images.length === 0) {
    errors.push('images must be a non-empty array');
    return errors;
  }
  if (req.body.images.length > 40) {
    errors.push('images must contain at most 40 items');
  }

  req.body.images.forEach((image, index) => {
    if (isBlank(image?.clientImageId)) {
      errors.push(`images[${index}].clientImageId is required`);
    } else {
      const clientImageId = String(image.clientImageId).trim();
      if (clientImageId.length > 120) {
        errors.push(`images[${index}].clientImageId must be 120 characters or fewer`);
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(clientImageId)) {
        errors.push(`images[${index}].clientImageId may only contain letters, numbers, dot, underscore, and hyphen`);
      }
    }
    if (isBlank(image?.captureStage)) {
      errors.push(`images[${index}].captureStage is required`);
    }
    if (image?.contentType) {
      const contentType = String(image.contentType).trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        errors.push(`images[${index}].contentType is not allowed`);
      }
    }
    if (image?.contentLength !== undefined && Number(image.contentLength) < 0) {
      errors.push(`images[${index}].contentLength must be >= 0`);
    }
    if (image?.sha256 !== undefined) {
      const hash = String(image.sha256).trim().toLowerCase();
      if (hash.length > 0 && !/^[a-f0-9]{32,128}$/i.test(hash)) {
        errors.push(`images[${index}].sha256 must be a valid hex string`);
      }
    }
  });

  if (req.body.clientSubmissionId && String(req.body.clientSubmissionId).length > 120) {
    errors.push('clientSubmissionId must be 120 characters or fewer');
  }
  return errors;
};

const validateConfirmMediaUpload = (req) => {
  const errors = [];
  if (isBlank(req.params.id)) errors.push('inspection id is required');
  if (isBlank(req.params.mediaId)) errors.push('media id is required');
  if (req.body.contentLength !== undefined && Number(req.body.contentLength) < 0) {
    errors.push('contentLength must be >= 0');
  }
  if (req.body.sha256 !== undefined) {
    const hash = String(req.body.sha256).trim().toLowerCase();
    if (hash.length > 0 && !/^[a-f0-9]{32,128}$/i.test(hash)) {
      errors.push('sha256 must be a valid hex string');
    }
  }
  if (req.body.width !== undefined && Number(req.body.width) <= 0) {
    errors.push('width must be > 0');
  }
  if (req.body.height !== undefined && Number(req.body.height) <= 0) {
    errors.push('height must be > 0');
  }
  return errors;
};

const validateRetryMediaUpload = (req) => {
  const errors = [];
  if (isBlank(req.params.id)) errors.push('inspection id is required');
  if (isBlank(req.params.mediaId)) errors.push('media id is required');
  if (req.body.contentType) {
    const contentType = String(req.body.contentType).trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      errors.push('contentType is not allowed');
    }
  }
  if (req.body.contentLength !== undefined && Number(req.body.contentLength) < 0) {
    errors.push('contentLength must be >= 0');
  }
  if (req.body.sha256 !== undefined) {
    const hash = String(req.body.sha256).trim().toLowerCase();
    if (hash.length > 0 && !/^[a-f0-9]{32,128}$/i.test(hash)) {
      errors.push('sha256 must be a valid hex string');
    }
  }
  return errors;
};

const validateInspectionImageUploadSession = (req) => {
  const errors = [];
  if (isBlank(req.body.inspectionId)) errors.push('inspectionId is required');
  const imageList = Array.isArray(req.body.images)
    ? req.body.images
    : req.body.image
      ? [req.body.image]
      : [];
  if (imageList.length === 0) {
    errors.push('images (or image) payload is required');
  }
  return errors;
};

const validateInspectionImageConfirmUpload = (req) => {
  const errors = [];
  if (isBlank(req.body.inspectionId)) errors.push('inspectionId is required');
  if (isBlank(req.body.mediaId)) errors.push('mediaId is required');
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
  validateCreateMediaUploadSession,
  validateConfirmMediaUpload,
  validateRetryMediaUpload,
  validateInspectionImageUploadSession,
  validateInspectionImageConfirmUpload,
  validateSubmitInspection,
  validateReviewInspection,
};
