const SENSOR_EVIDENCE_V2_VERSION = 'sensor-evidence-v2';

const SensorValidity = Object.freeze({
  VALID_STABLE: 'VALID_STABLE',
  VALID_UNSTABLE: 'VALID_UNSTABLE',
  STALE: 'STALE',
  OUT_OF_SYNC_WINDOW: 'OUT_OF_SYNC_WINDOW',
  WARMING_UP: 'WARMING_UP',
  DISCONNECTED: 'DISCONNECTED',
  PARSE_ERROR: 'PARSE_ERROR',
  DEFAULT_OR_ZERO_SUSPECT: 'DEFAULT_OR_ZERO_SUSPECT',
  INSUFFICIENT_SAMPLES: 'INSUFFICIENT_SAMPLES',
  CALIBRATION_UNKNOWN: 'CALIBRATION_UNKNOWN',
  SENSOR_ERROR: 'SENSOR_ERROR',
  LEGACY_UNKNOWN: 'LEGACY_UNKNOWN',
  UNAVAILABLE: 'UNAVAILABLE',
});

const SensorConfidence = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INVALID: 'INVALID',
  UNKNOWN: 'UNKNOWN',
});

const SensorTimestampSource = Object.freeze({
  SENSOR_MEASUREMENT_TIME: 'SENSOR_MEASUREMENT_TIME',
  SENSOR_UPTIME_MAPPED: 'SENSOR_UPTIME_MAPPED',
  PHONE_RECEIVE_TIME: 'PHONE_RECEIVE_TIME',
  LEGACY_UNKNOWN: 'LEGACY_UNKNOWN',
});

const DEFAULT_SENSOR_EVIDENCE_CONFIG = Object.freeze({
  minSamples: 3,
  stablePpmSpreadAbsolute: 8,
  stablePpmSpreadFraction: 0.25,
  highSyncDeltaMs: 750,
  maximumSyncDeltaMs: 3000,
  staleAgeMs: 5000,
  minimumRssiDbm: -90,
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) => Number(Number(value).toFixed(2));

const numberOrNull = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const enumValue = (value, allowed, fallback) => {
  const normalized = String(value || '').trim().toUpperCase();
  return Object.values(allowed).includes(normalized) ? normalized : fallback;
};

const median = (values = []) => {
  const valid = values.map(numberOrNull).filter((value) => value !== null).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
};

const standardDeviation = (values = []) => {
  const valid = values.map(numberOrNull).filter((value) => value !== null);
  if (valid.length < 2) return null;
  const average = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return Math.sqrt(valid.reduce((sum, value) => sum + ((value - average) ** 2), 0) / valid.length);
};

const normalizeWindow = (value = {}) => {
  const samples = Array.isArray(value.samples) ? value.samples : [];
  const ppmValues = samples.map((sample) => sample?.ppm).filter((item) => numberOrNull(item) !== null);
  const temperatureValues = samples.map((sample) => sample?.temperature).filter((item) => numberOrNull(item) !== null);
  const humidityValues = samples.map((sample) => sample?.humidity).filter((item) => numberOrNull(item) !== null);
  const minPpm = numberOrNull(value.minPpm) ?? (ppmValues.length ? Math.min(...ppmValues.map(Number)) : null);
  const maxPpm = numberOrNull(value.maxPpm) ?? (ppmValues.length ? Math.max(...ppmValues.map(Number)) : null);
  const medianPpm = numberOrNull(value.medianPpm) ?? median(ppmValues);
  const meanPpm = numberOrNull(value.meanPpm) ?? (ppmValues.length ? ppmValues.map(Number).reduce((a, b) => a + b, 0) / ppmValues.length : null);
  const spread = numberOrNull(value.spreadPpm) ?? (minPpm !== null && maxPpm !== null ? maxPpm - minPpm : null);
  return {
    sampleCount: numberOrNull(value.sampleCount) ?? samples.length,
    medianPpm,
    minPpm,
    maxPpm,
    meanPpm,
    standardDeviationPpm: numberOrNull(value.standardDeviationPpm) ?? standardDeviation(ppmValues),
    spreadPpm: spread,
    temperatureMedian: numberOrNull(value.temperatureMedian) ?? median(temperatureValues),
    humidityMedian: numberOrNull(value.humidityMedian) ?? median(humidityValues),
    trend: String(value.trend || 'UNKNOWN').trim().toUpperCase(),
  };
};

const normaliseSensorEvidence = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const nearest = input.nearestSample && typeof input.nearestSample === 'object'
    ? input.nearestSample
    : input.sensorNearestSample && typeof input.sensorNearestSample === 'object'
      ? input.sensorNearestSample
      : null;
  const window = normalizeWindow(input.captureWindow || input.windowSummary || input.sensorWindow || {});
  const ppm = numberOrNull(nearest?.ppm) ?? window.medianPpm;
  const timestampSource = enumValue(
    input.sensorTimestampSource || nearest?.timestampSource,
    SensorTimestampSource,
    SensorTimestampSource.PHONE_RECEIVE_TIME
  );
  return {
    protocolVersion: String(input.captureProtocolVersion || input.protocolVersion || SENSOR_EVIDENCE_V2_VERSION).slice(0, 80),
    evidenceId: String(input.evidenceId || '').trim() || null,
    nearestSample: nearest
      ? {
          readingId: String(nearest.readingId || nearest.id || '').trim() || null,
          clientReadingId: String(nearest.clientReadingId || '').trim() || null,
          sensorDeviceId: String(nearest.sensorDeviceId || nearest.deviceId || '').trim() || null,
          sequence: numberOrNull(nearest.sequence),
          ppm,
          temperature: numberOrNull(nearest.temperature),
          humidity: numberOrNull(nearest.humidity),
          batteryLevel: numberOrNull(nearest.batteryLevel),
          rssi: numberOrNull(nearest.rssi),
          rawPayload: String(nearest.rawPayload || '').slice(0, 4000) || null,
          sensorMeasuredAt: nearest.sensorMeasuredAt || null,
          sensorReceivedAt: nearest.sensorReceivedAt || nearest.timestamp || null,
          phoneMonotonicReceivedMs: numberOrNull(nearest.phoneMonotonicReceivedMs),
          wallClockReceivedAt: nearest.wallClockReceivedAt || null,
          parseStatus: String(nearest.parseStatus || 'PARSED').trim().toUpperCase(),
          connectionState: String(nearest.connectionState || 'CONNECTED').trim().toUpperCase(),
        }
      : null,
    captureWindow: window,
    camera: {
      cameraOpenedAt: input.cameraOpenedAt || null,
      shutterRequestedAt: input.shutterRequestedAt || null,
      exposureStartedAt: input.exposureStartedAt || null,
      imageReturnedAt: input.imageReturnedAt || null,
      imagePersistedAt: input.imagePersistedAt || null,
      timestampSource: String(input.cameraTimestampSource || 'IMAGE_RETURN_TIME').trim().toUpperCase(),
    },
    sensorTimestampSource: timestampSource,
    sensorCalibrationVersion: String(input.sensorCalibrationVersion || '').trim() || null,
    // This boolean is deliberately explicit. A version string alone does not prove calibration.
    calibrationVerified: input.calibrationVerified === true,
    warmupComplete: input.warmupComplete === true,
    syncDeltaMs: numberOrNull(input.syncDeltaMs ?? input.sensorSyncDeltaMs),
    firmwareVersion: String(input.firmwareVersion || '').trim() || null,
  };
};

const classifySensorEvidence = (input, overrides = {}) => {
  const evidence = normaliseSensorEvidence(input);
  if (!evidence) {
    return {
      evidence: null,
      validity: SensorValidity.UNAVAILABLE,
      confidence: SensorConfidence.INVALID,
      confidenceScore: 0,
      classification: 'UNAVAILABLE',
      reasons: ['sensor_evidence_missing'],
    };
  }

  const config = { ...DEFAULT_SENSOR_EVIDENCE_CONFIG, ...(overrides || {}) };
  const sample = evidence.nearestSample;
  const window = evidence.captureWindow;
  const reasons = [];
  const ppm = sample?.ppm ?? window.medianPpm;
  const delta = evidence.syncDeltaMs;
  let validity = SensorValidity.VALID_STABLE;

  if (!sample) {
    validity = SensorValidity.UNAVAILABLE;
    reasons.push('nearest_sample_missing');
  } else if (sample.connectionState !== 'CONNECTED') {
    validity = SensorValidity.DISCONNECTED;
    reasons.push('sensor_not_connected_at_capture');
  } else if (sample.parseStatus !== 'PARSED' || ppm === null) {
    validity = SensorValidity.PARSE_ERROR;
    reasons.push('sensor_packet_not_parseable');
  } else if (!evidence.warmupComplete) {
    validity = SensorValidity.WARMING_UP;
    reasons.push('warmup_not_verified');
  } else if (ppm === 0 && !evidence.calibrationVerified) {
    validity = SensorValidity.DEFAULT_OR_ZERO_SUSPECT;
    reasons.push('zero_without_verified_calibration');
  } else if (delta === null || Math.abs(delta) > config.maximumSyncDeltaMs) {
    validity = SensorValidity.OUT_OF_SYNC_WINDOW;
    reasons.push('sensor_sample_outside_sync_window');
  } else if (window.sampleCount < config.minSamples) {
    validity = SensorValidity.INSUFFICIENT_SAMPLES;
    reasons.push('insufficient_capture_window_samples');
  } else if (!evidence.calibrationVerified) {
    validity = SensorValidity.CALIBRATION_UNKNOWN;
    reasons.push('sensor_calibration_not_verified');
  } else {
    const stableSpread = Math.max(
      config.stablePpmSpreadAbsolute,
      Math.abs(window.medianPpm || ppm || 0) * config.stablePpmSpreadFraction
    );
    if (window.spreadPpm !== null && window.spreadPpm > stableSpread) {
      validity = SensorValidity.VALID_UNSTABLE;
      reasons.push('capture_window_ppm_unstable');
    }
  }

  let confidenceScore = 100;
  if (delta === null) confidenceScore -= 30;
  else if (Math.abs(delta) > config.highSyncDeltaMs) confidenceScore -= 15;
  if (window.sampleCount < config.minSamples) confidenceScore -= 30;
  if (window.spreadPpm !== null && window.medianPpm !== null && window.spreadPpm > Math.max(config.stablePpmSpreadAbsolute, Math.abs(window.medianPpm) * config.stablePpmSpreadFraction)) confidenceScore -= 25;
  if (sample?.rssi !== null && sample?.rssi !== undefined && Number(sample.rssi) < config.minimumRssiDbm) confidenceScore -= 10;
  if (evidence.sensorTimestampSource === SensorTimestampSource.PHONE_RECEIVE_TIME) confidenceScore -= 10;
  if (!evidence.calibrationVerified) confidenceScore -= 35;
  if (!evidence.warmupComplete) confidenceScore -= 40;
  if (validity === SensorValidity.DISCONNECTED || validity === SensorValidity.PARSE_ERROR || validity === SensorValidity.UNAVAILABLE || validity === SensorValidity.DEFAULT_OR_ZERO_SUSPECT) confidenceScore = 0;
  confidenceScore = clamp(confidenceScore, 0, 100);
  const confidence = confidenceScore >= 80
    ? SensorConfidence.HIGH
    : confidenceScore >= 55
      ? SensorConfidence.MEDIUM
      : confidenceScore > 0
        ? SensorConfidence.LOW
        : SensorConfidence.INVALID;

  // "Fresh" is deliberately impossible without a verified calibration profile.
  let classification = 'RECORDED_UNCLASSIFIED';
  if (confidence === SensorConfidence.INVALID || validity === SensorValidity.CALIBRATION_UNKNOWN) {
    classification = 'UNRELIABLE';
  } else if (ppm !== null && evidence.calibrationVerified) {
    if (ppm <= 15) classification = 'LOW_CONCENTRATION';
    else if (ppm <= 40) classification = 'NORMAL_RANGE';
    else if (ppm <= 75) classification = 'ELEVATED';
    else if (ppm <= 120) classification = 'HIGH';
    else classification = 'CRITICAL';
  }

  return {
    evidence,
    validity,
    confidence,
    confidenceScore: round2(confidenceScore),
    classification,
    reasons,
  };
};

const toInspectionMediaSensorEvidenceFields = (input) => {
  const quality = classifySensorEvidence(input);
  const evidence = quality.evidence;
  if (!evidence) {
    return {
      sensor_evidence: null,
      capture_protocol_version: null,
      sensor_sync_quality: SensorValidity.UNAVAILABLE,
      sensor_confidence: SensorConfidence.INVALID,
    };
  }
  const sample = evidence.nearestSample || {};
  const window = evidence.captureWindow || {};
  const camera = evidence.camera || {};
  return {
    evidence_id: evidence.evidenceId,
    camera_opened_at: camera.cameraOpenedAt || null,
    shutter_requested_at: camera.shutterRequestedAt || null,
    camera_exposure_at: camera.exposureStartedAt || null,
    image_returned_at: camera.imageReturnedAt || null,
    image_persisted_at: camera.imagePersistedAt || null,
    camera_timestamp_source: camera.timestampSource || null,
    sensor_measured_at: sample.sensorMeasuredAt || null,
    sensor_received_at: sample.sensorReceivedAt || null,
    sensor_timestamp_source: evidence.sensorTimestampSource,
    sensor_sync_delta_ms: evidence.syncDeltaMs,
    sensor_sync_quality: quality.validity,
    sensor_stability: quality.validity === SensorValidity.VALID_STABLE ? 'STABLE' : quality.validity === SensorValidity.VALID_UNSTABLE ? 'UNSTABLE' : 'UNKNOWN',
    sensor_confidence: quality.confidence,
    sensor_sample_count: window.sampleCount ?? null,
    sensor_window_median_ppm: window.medianPpm,
    sensor_window_min_ppm: window.minPpm,
    sensor_window_max_ppm: window.maxPpm,
    sensor_window_spread: window.spreadPpm,
    sensor_sequence: sample.sequence,
    sensor_calibration_version: evidence.sensorCalibrationVersion,
    capture_protocol_version: evidence.protocolVersion,
    sensor_evidence: {
      ...evidence,
      validation: {
        status: quality.validity,
        confidence: quality.confidence,
        confidenceScore: quality.confidenceScore,
        classification: quality.classification,
        reasons: quality.reasons,
      },
    },
  };
};

module.exports = {
  SENSOR_EVIDENCE_V2_VERSION,
  SensorValidity,
  SensorConfidence,
  SensorTimestampSource,
  DEFAULT_SENSOR_EVIDENCE_CONFIG,
  normaliseSensorEvidence,
  classifySensorEvidence,
  toInspectionMediaSensorEvidenceFields,
  median,
  standardDeviation,
};
