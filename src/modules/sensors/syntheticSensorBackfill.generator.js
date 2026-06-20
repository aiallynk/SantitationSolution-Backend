const crypto = require('crypto');

const GENERATOR_VERSION = 'inspection-sensor-snapshot-v1';

const SCORE_BANDS = Object.freeze({
  excellent: {
    label: 'excellent',
    minScore: 85,
    maxScore: 100,
    sensorScore: [8.5, 10.0],
    temperature: [24.0, 30.0],
    humidity: [38.0, 58.0],
    mq135: [0.02, 0.25],
    mq137: [0.05, 0.65],
    batteryLevel: [72, 100],
    rssi: [-65, -45],
  },
  good: {
    label: 'good',
    minScore: 70,
    maxScore: 84,
    sensorScore: [7.0, 8.4],
    temperature: [25.0, 31.5],
    humidity: [45.0, 65.0],
    mq135: [0.15, 0.55],
    mq137: [0.35, 1.10],
    batteryLevel: [60, 100],
    rssi: [-72, -50],
  },
  average: {
    label: 'average',
    minScore: 50,
    maxScore: 69,
    sensorScore: [5.0, 6.9],
    temperature: [26.0, 33.0],
    humidity: [55.0, 75.0],
    mq135: [0.45, 1.15],
    mq137: [0.90, 2.00],
    batteryLevel: [45, 95],
    rssi: [-82, -55],
  },
  poor: {
    label: 'poor',
    minScore: 30,
    maxScore: 49,
    sensorScore: [3.0, 4.9],
    temperature: [27.0, 36.0],
    humidity: [68.0, 86.0],
    mq135: [1.00, 2.30],
    mq137: [1.80, 3.70],
    batteryLevel: [35, 90],
    rssi: [-88, -60],
  },
  critical: {
    label: 'critical',
    minScore: 0,
    maxScore: 29,
    sensorScore: [0.0, 2.9],
    temperature: [28.0, 38.5],
    humidity: [78.0, 92.0],
    mq135: [2.00, 4.50],
    mq137: [3.20, 6.50],
    batteryLevel: [25, 85],
    rssi: [-92, -65],
  },
});

const HARD_BOUNDS = Object.freeze({
  sensorScore: [0.0, 10.0],
  temperature: [18.0, 42.0],
  humidity: [20.0, 95.0],
  mq135: [0.0, 5.0],
  mq137: [0.0, 8.0],
  batteryLevel: [10, 100],
  rssi: [-95, -35],
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const roundTo = (value, precision) => {
  const factor = 10 ** precision;
  return Math.round(Number(value) * factor) / factor;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const unitRandom = (seed, label) => {
  const hex = sha256Hex(`${seed}:${label}`);
  return parseInt(hex.slice(0, 13), 16) / 0x10000000000000;
};

const signedRandom = (seed, label) => unitRandom(seed, label) * 2 - 1;

const pickBand = (score) => {
  const normalized = clamp(Number(score), 0, 100);
  if (normalized >= 85) return SCORE_BANDS.excellent;
  if (normalized >= 70) return SCORE_BANDS.good;
  if (normalized >= 50) return SCORE_BANDS.average;
  if (normalized >= 30) return SCORE_BANDS.poor;
  return SCORE_BANDS.critical;
};

const scorePositionInBand = (score, band) => {
  const value = clamp(Number(score), band.minScore, band.maxScore);
  const span = Math.max(1, band.maxScore - band.minScore);
  return clamp((value - band.minScore) / span, 0, 1);
};

const biasedSample = ({ seed, label, range, bias, jitterWeight = 0.35 }) => {
  const [min, max] = range;
  const random = unitRandom(seed, label);
  const mixed = clamp(bias * (1 - jitterWeight) + random * jitterWeight, 0, 1);
  return min + (max - min) * mixed;
};

const monthHumidityOffset = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 0;
  const month = date.getUTCMonth() + 1;
  if (month === 6) return 3.0;
  if (month === 5) return 1.5;
  return 0;
};

const hourTemperatureOffset = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 0;
  const utcHour = date.getUTCHours();
  const istHour = (utcHour + 5 + (date.getUTCMinutes() >= 30 ? 1 : 0)) % 24;
  if (istHour >= 12 && istHour <= 17) return 1.2;
  if (istHour >= 5 && istHour <= 8) return -0.5;
  return 0;
};

const asDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const resolveReadingTime = ({ capturedAt, submittedAt, seed }) => {
  const captured = asDateOrNull(capturedAt);
  const submitted = asDateOrNull(submittedAt);
  const base = captured || submitted || new Date(0);
  const offsetMinutes = Math.floor(unitRandom(seed, 'reading-minute-offset') * 11);
  let reading = new Date(base.getTime() + offsetMinutes * 60_000);
  if (captured && submitted && submitted.getTime() >= captured.getTime() && reading.getTime() > submitted.getTime()) {
    reading = submitted;
  }
  return reading.toISOString();
};

const buildSeed = ({ batchId, tenantId, inspectionId, toiletUnitId }) => {
  const seedInput = `${GENERATOR_VERSION}:${batchId}:${tenantId}:${inspectionId}:${toiletUnitId || 'none'}`;
  return sha256Hex(seedInput);
};

const generateSyntheticSensorSnapshot = ({
  inspectionId,
  tenantId,
  toiletUnitId = null,
  capturedAt,
  submittedAt = null,
  selectedScore,
  scoreSourceField,
  batchId,
  generatedAt,
  avgBeforeScore = null,
  avgAfterScore = null,
}) => {
  if (!inspectionId) throw new Error('inspectionId is required');
  if (!tenantId) throw new Error('tenantId is required');
  if (!batchId) throw new Error('batchId is required');
  const scoreValue = toNumberOrNull(selectedScore);
  if (scoreValue === null) throw new Error('selectedScore is required');

  const scoreUsed = roundTo(clamp(scoreValue, 0, 100), 2);
  const band = pickBand(scoreUsed);
  const position = scorePositionInBand(scoreUsed, band);
  const seed = buildSeed({ batchId, tenantId, inspectionId, toiletUnitId });
  const readingTime = resolveReadingTime({ capturedAt, submittedAt, seed });
  const readingDate = new Date(readingTime);

  const toiletBaseline = signedRandom(seed, `toilet-baseline:${toiletUnitId || 'none'}`);
  const humidBaseline = toiletBaseline * 2.2 + monthHumidityOffset(readingDate);
  const tempBaseline = signedRandom(seed, 'temp-baseline') * 0.5 + hourTemperatureOffset(readingDate);
  const mqBaseline = toiletBaseline * 0.06;

  const sensorScore = roundTo(
    clamp(
      biasedSample({ seed, label: 'sensor-score', range: band.sensorScore, bias: position, jitterWeight: 0.25 }),
      ...HARD_BOUNDS.sensorScore
    ),
    1
  );
  const temperature = roundTo(
    clamp(
      biasedSample({ seed, label: 'temperature', range: band.temperature, bias: 1 - position * 0.35 }) + tempBaseline,
      Math.max(HARD_BOUNDS.temperature[0], band.temperature[0]),
      Math.min(HARD_BOUNDS.temperature[1], band.temperature[1])
    ),
    1
  );
  const humidity = roundTo(
    clamp(
      biasedSample({ seed, label: 'humidity', range: band.humidity, bias: 1 - position * 0.55 }) + humidBaseline,
      Math.max(HARD_BOUNDS.humidity[0], band.humidity[0]),
      Math.min(HARD_BOUNDS.humidity[1], band.humidity[1])
    ),
    1
  );
  const mq135 = roundTo(
    clamp(
      biasedSample({ seed, label: 'mq135', range: band.mq135, bias: 1 - position, jitterWeight: 0.3 }) + mqBaseline,
      Math.max(HARD_BOUNDS.mq135[0], band.mq135[0]),
      Math.min(HARD_BOUNDS.mq135[1], band.mq135[1])
    ),
    2
  );
  const mq137 = roundTo(
    clamp(
      biasedSample({ seed, label: 'mq137', range: band.mq137, bias: 1 - position, jitterWeight: 0.3 }) + mqBaseline,
      Math.max(HARD_BOUNDS.mq137[0], band.mq137[0]),
      Math.min(HARD_BOUNDS.mq137[1], band.mq137[1])
    ),
    2
  );
  const batteryLevel = Math.round(
    clamp(
      biasedSample({ seed, label: 'battery', range: band.batteryLevel, bias: 0.65, jitterWeight: 0.6 }),
      ...HARD_BOUNDS.batteryLevel
    )
  );
  const rssi = Math.round(
    clamp(
      biasedSample({ seed, label: 'rssi', range: band.rssi, bias: 0.55, jitterWeight: 0.65 }),
      ...HARD_BOUNDS.rssi
    )
  );

  const rawPayload = [
    sensorScore.toFixed(1),
    mq135.toFixed(2),
    mq137.toFixed(2),
    temperature.toFixed(1),
    humidity.toFixed(1),
  ].join(',');

  return {
    sensorDeviceId: null,
    deviceName: 'Synthetic Historical Sensor',
    rawPayload,
    score: sensorScore,
    field1: sensorScore,
    field2: mq135,
    field3: mq137,
    sensorToiletScore: sensorScore,
    mq135,
    mq137,
    temperature,
    humidity,
    fields: {
      field_1: sensorScore,
      field_2: mq135,
      field_3: mq137,
      field_4: temperature,
      field_5: humidity,
    },
    rssi,
    batteryLevel,
    schemaVersion: 'synthetic_wand_v2',
    clientReadingId: `synthetic-backfill:${batchId}:${inspectionId}`,
    sensorReadingId: null,
    readingTime,
    sensorDataSource: 'synthetic_historical_backfill',
    isSynthetic: true,
    isBackfilled: true,
    backfillSource: 'inspection_ai_score_correlation',
    backfillBatchId: batchId,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    scoreSourceField,
    scoreUsed,
    scoreBand: band.label,
    avgBeforeScore: toNumberOrNull(avgBeforeScore),
    avgAfterScore: toNumberOrNull(avgAfterScore),
    randomSeed: seed,
    syntheticReason: 'historical_inspection_sensor_snapshot_backfill',
    doNotUseForRealTelemetry: true,
  };
};

module.exports = {
  GENERATOR_VERSION,
  HARD_BOUNDS,
  SCORE_BANDS,
  buildSeed,
  generateSyntheticSensorSnapshot,
  pickBand,
  resolveReadingTime,
  toNumberOrNull,
};
