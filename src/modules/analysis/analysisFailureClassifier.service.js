const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'NETWORK_ERROR',
  'INLINE_ANALYSIS_TIMEOUT',
  'OPENAI_REQUEST_FAILED',
  'IMAGE_SOURCE_UNAVAILABLE',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /temporar/i,
  /rate limit/i,
  /429/i,
  /503/i,
  /502/i,
  /504/i,
  /network/i,
  /socket/i,
  /fetch failed/i,
  /could not resolve/i,
  /connection/i,
];

const PERMANENT_ERROR_CODES = new Set([
  'OPENAI_DETECTION_PARSE_FAILED',
  'OPENAI_SCORING_PARSE_FAILED',
  'OPENAI_INVALID_JSON',
  'NO_TOILET_DETECTED',
  'LOW_VISIBILITY',
  'UPLOAD_HASH_MISMATCH',
  'UPLOAD_CONTENT_TYPE_MISMATCH',
  'UPLOAD_SIZE_MISMATCH',
  'IMAGE_CORRUPT',
  'INVALID_MEDIA_TYPE',
]);

const normalizeErrorMessage = (error) =>
  String(error?.message || error || 'Unknown analysis failure')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

const normalizeErrorCode = (error) =>
  String(
    error?.code ||
      error?.name ||
      error?.response?.data?.error?.code ||
      error?.cause?.code ||
      ''
  )
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 120);

const classifyAnalysisFailure = (error) => {
  const message = normalizeErrorMessage(error);
  const code = normalizeErrorCode(error);
  const status = Number(error?.status || error?.response?.status || 0);

  if (PERMANENT_ERROR_CODES.has(code)) {
    return {
      classification: 'permanent',
      retryable: false,
      errorCode: code || 'AI_ERROR_PERMANENT',
      message,
    };
  }

  if (status === 429 || status >= 500) {
    return {
      classification: 'transient',
      retryable: true,
      errorCode: code || 'AI_ERROR_TRANSIENT',
      message,
    };
  }

  if (TRANSIENT_ERROR_CODES.has(code)) {
    return {
      classification: 'transient',
      retryable: true,
      errorCode: code,
      message,
    };
  }

  if (TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      classification: 'transient',
      retryable: true,
      errorCode: code || 'AI_ERROR_TRANSIENT',
      message,
    };
  }

  return {
    classification: 'permanent',
    retryable: false,
    errorCode: code || 'AI_ERROR_PERMANENT',
    message,
  };
};

module.exports = {
  classifyAnalysisFailure,
  normalizeErrorCode,
  normalizeErrorMessage,
};
