const FLAG_KEYS = Object.freeze({
  synchronizedSensorCaptureV2: 'synchronized_sensor_capture_v2',
  explainableScoringV2: 'explainable_scoring_v2',
});

const asBoolean = (value) => value === true || String(value || '').trim().toLowerCase() === 'true';

const resolveTenantFeatureFlags = (tenant = null) => {
  const metadata = tenant?.metadata && typeof tenant.metadata === 'object' ? tenant.metadata : {};
  const values = metadata.featureFlags && typeof metadata.featureFlags === 'object'
    ? metadata.featureFlags
    : metadata.feature_flags && typeof metadata.feature_flags === 'object'
      ? metadata.feature_flags
      : {};
  return {
    synchronizedSensorCaptureV2: asBoolean(
      values[FLAG_KEYS.synchronizedSensorCaptureV2] ?? values.synchronizedSensorCaptureV2
    ),
    explainableScoringV2: asBoolean(
      values[FLAG_KEYS.explainableScoringV2] ?? values.explainableScoringV2
    ),
  };
};

module.exports = { FLAG_KEYS, resolveTenantFeatureFlags };
