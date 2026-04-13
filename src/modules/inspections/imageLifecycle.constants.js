const IMAGE_PROCESSING_STATES = Object.freeze({
  CAPTURED: 'captured',
  QUEUED_FOR_UPLOAD: 'queued_for_upload',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  STORAGE_VERIFIED: 'storage_verified',
  QUEUED_FOR_AI: 'queued_for_ai',
  AI_PROCESSING: 'ai_processing',
  AI_RETRYING: 'ai_retrying',
  AI_COMPLETED: 'ai_completed',
  AI_FAILED_TRANSIENT: 'ai_failed_transient',
  AI_FAILED_PERMANENT: 'ai_failed_permanent',
  MANUAL_REVIEW_REQUIRED: 'manual_review_required',
  UPLOAD_FAILED_PERMANENT: 'upload_failed_permanent',
});

const NON_TERMINAL_STATES = new Set([
  IMAGE_PROCESSING_STATES.CAPTURED,
  IMAGE_PROCESSING_STATES.QUEUED_FOR_UPLOAD,
  IMAGE_PROCESSING_STATES.UPLOADING,
  IMAGE_PROCESSING_STATES.UPLOADED,
  IMAGE_PROCESSING_STATES.STORAGE_VERIFIED,
  IMAGE_PROCESSING_STATES.QUEUED_FOR_AI,
  IMAGE_PROCESSING_STATES.AI_PROCESSING,
  IMAGE_PROCESSING_STATES.AI_RETRYING,
  IMAGE_PROCESSING_STATES.AI_FAILED_TRANSIENT,
]);

const TERMINAL_STATES = new Set([
  IMAGE_PROCESSING_STATES.AI_COMPLETED,
  IMAGE_PROCESSING_STATES.AI_FAILED_PERMANENT,
  IMAGE_PROCESSING_STATES.MANUAL_REVIEW_REQUIRED,
  IMAGE_PROCESSING_STATES.UPLOAD_FAILED_PERMANENT,
]);

const resolveLegacyProcessingState = ({
  uploadStatus = '',
  aiStatus = '',
  reviewRequired = false,
}) => {
  const normalizedUpload = String(uploadStatus || '').trim().toLowerCase();
  const normalizedAi = String(aiStatus || '').trim().toUpperCase();

  if (normalizedAi === 'AI_COMPLETED') return IMAGE_PROCESSING_STATES.AI_COMPLETED;
  if (normalizedAi === 'AI_PROCESSING') return IMAGE_PROCESSING_STATES.AI_PROCESSING;
  if (normalizedAi === 'AI_QUEUED') return IMAGE_PROCESSING_STATES.QUEUED_FOR_AI;
  if (normalizedAi === 'AI_FAILED') {
    return reviewRequired
      ? IMAGE_PROCESSING_STATES.MANUAL_REVIEW_REQUIRED
      : IMAGE_PROCESSING_STATES.AI_FAILED_PERMANENT;
  }
  if (normalizedUpload === 'confirmed' || normalizedUpload === 'uploaded') {
    return IMAGE_PROCESSING_STATES.STORAGE_VERIFIED;
  }
  if (normalizedUpload === 'uploading') return IMAGE_PROCESSING_STATES.UPLOADING;
  if (normalizedUpload === 'upload_session_created' || normalizedUpload === 'created') {
    return IMAGE_PROCESSING_STATES.QUEUED_FOR_UPLOAD;
  }
  return IMAGE_PROCESSING_STATES.CAPTURED;
};

module.exports = {
  IMAGE_PROCESSING_STATES,
  NON_TERMINAL_STATES,
  TERMINAL_STATES,
  resolveLegacyProcessingState,
};
