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
 * Confirmed wand v3 field sequence: field_1=ppm (TGS gas concentration
 * sensor), field_2=temperature, field_3=humidity.
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
 *   ppm: number|null, temperature: number|null, humidity: number|null,
 *   battery: number|null, rssi: number|null,
 *   readingTime: Date|null, raw: string|null, hasEnvironmental: boolean
 * }}
 */
const toSensorMetrics = (input) => {
  const empty = {
    ppm: null,
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
      ppm: num(parsed.parsed.ppm),
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
    ppm: firstNum(input.ppm, parsedFields.ppm),
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
    metrics.ppm != null;
  return metrics;
};

module.exports = { toSensorMetrics };
