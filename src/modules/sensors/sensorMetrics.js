/**
 * Phase 1 — Centralized SensorMetrics.
 *
 * A single canonical shape every downstream consumer (threshold engine, alert
 * engine, AI scoring context, dashboards) reads from, so parsing logic is never
 * duplicated. Accepts any of:
 *   - a SensorReading model row (snake_case columns + raw_payload JSONB)
 *   - a mapped reading (camelCase)
 *   - an inspection `sensor_snapshot` object
 *   - a verbatim CSV payload string / array
 *
 * Confirmed wand v2 field sequence: field_1=score, field_2=MQ135 (air quality
 * gas), field_3=MQ137 (ammonia gas), field_4=temperature, field_5=humidity.
 * MQ values are raw, uncalibrated analog readings — never relabelled as ppm.
 */

const { parseSensorPayload } = require('./sensorPayload.parser');

const num = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstNum = (...values) => {
  for (const value of values) {
    const parsed = num(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * @returns {{
 *   score: number|null, mq135: number|null, mq137: number|null,
 *   temperature: number|null, humidity: number|null,
 *   battery: number|null, rssi: number|null,
 *   readingTime: Date|null, raw: string|null, hasEnvironmental: boolean
 * }}
 */
const toSensorMetrics = (input) => {
  const empty = {
    score: null,
    mq135: null,
    mq137: null,
    temperature: null,
    humidity: null,
    battery: null,
    rssi: null,
    readingTime: null,
    raw: null,
    hasEnvironmental: false,
  };
  if (input === undefined || input === null) return empty;

  // Raw CSV string or array — parse directly.
  if (typeof input === 'string' || Array.isArray(input)) {
    const parsed = parseSensorPayload(input);
    return {
      score: num(parsed.parsed.score),
      mq135: num(parsed.parsed.mq135),
      mq137: num(parsed.parsed.mq137),
      temperature: num(parsed.parsed.temperature),
      humidity: num(parsed.parsed.humidity),
      battery: null,
      rssi: null,
      readingTime: null,
      raw: parsed.raw || null,
      hasEnvironmental:
        parsed.parsed.temperature != null || parsed.parsed.humidity != null,
    };
  }

  if (typeof input !== 'object') return empty;

  // raw_payload can be the structured ingestion envelope ({ raw, parsed, fields })
  // or a plain CSV string; reuse the parser to recover named fields.
  const rawPayload = input.raw_payload ?? input.rawPayload ?? input.raw ?? null;
  const parsedFromRaw = rawPayload != null ? parseSensorPayload(rawPayload) : null;
  const parsedFields = parsedFromRaw ? parsedFromRaw.parsed : {};
  const rawString =
    (parsedFromRaw && parsedFromRaw.raw) ||
    (typeof rawPayload === 'string' ? rawPayload : null);

  const metrics = {
    score: firstNum(input.score, parsedFields.score),
    mq135: firstNum(input.mq135, input.mq135Raw, parsedFields.mq135),
    mq137: firstNum(input.mq137, input.mq137Raw, parsedFields.mq137),
    temperature: firstNum(input.temperature, parsedFields.temperature),
    humidity: firstNum(input.humidity, parsedFields.humidity),
    battery: firstNum(input.battery, input.batteryLevel, input.battery_level),
    rssi: firstNum(input.rssi, input.signalStrength, input.signal_strength),
    readingTime: toDate(
      input.readingTime || input.timestamp || input.last_seen_at || input.lastSeenAt
    ),
    raw: rawString,
  };
  metrics.hasEnvironmental =
    metrics.temperature != null ||
    metrics.humidity != null ||
    metrics.mq135 != null ||
    metrics.mq137 != null;
  return metrics;
};

module.exports = { toSensorMetrics };
