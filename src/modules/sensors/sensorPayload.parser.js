/**
 * Version-tolerant parser for BLE Sanitation Wand payloads.
 *
 * Confirmed firmware field sequence:
 *   - V2 (5 fields):  field_1 = overall toilet score, field_2 = MQ135 (air
 *     quality gas), field_3 = MQ137 (ammonia gas), field_4 = temperature,
 *     field_5 = humidity.
 *   - legacy V1 (2 fields): field_1 = score, field_2 = voltage (no env fields).
 * Any other shape is stored generically as field_1..field_N with version
 * 'unknown'.
 *
 * The verbatim raw payload is ALWAYS preserved so nothing is ever discarded and
 * future firmware revisions can be re-parsed offline.
 */

const toFiniteNumber = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Split a payload into an ordered list of raw string tokens.
 * Accepts a CSV string, an array, or an object with a `raw`/`payload` field.
 */
const tokenize = (payload) => {
  if (Array.isArray(payload)) {
    return payload.map((item) => (item === undefined || item === null ? '' : String(item).trim()));
  }
  if (typeof payload === 'string') {
    if (payload.trim() === '') return [];
    return payload.split(',').map((token) => token.trim());
  }
  if (payload && typeof payload === 'object') {
    const inner = payload.raw ?? payload.payload ?? payload.value;
    if (typeof inner === 'string' || Array.isArray(inner)) {
      return tokenize(inner);
    }
  }
  return [];
};

const rawString = (payload) => {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.join(',');
  if (payload && typeof payload === 'object') {
    const inner = payload.raw ?? payload.payload ?? payload.value;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) return inner.join(',');
  }
  return payload === undefined || payload === null ? '' : String(payload);
};

/**
 * @param {string|Array|Object} payload  verbatim BLE payload
 * @returns {{
 *   raw: string,
 *   fieldCount: number,
 *   version: 'v2'|'legacy_v1'|'unknown'|'empty',
 *   fields: Record<string, number|null>,   // field_1..field_N (numeric where possible)
 *   parsed: {
 *     score: number|null, mq135: number|null, mq137: number|null,
 *     temperature: number|null, humidity: number|null
 *   }
 * }}
 */
const parseSensorPayload = (payload) => {
  const raw = rawString(payload);
  const tokens = tokenize(payload);

  const fields = {};
  tokens.forEach((token, index) => {
    fields[`field_${index + 1}`] = toFiniteNumber(token);
  });

  const result = {
    raw,
    fieldCount: tokens.length,
    version: 'unknown',
    fields,
    parsed: {
      score: null,
      mq135: null,
      mq137: null,
      temperature: null,
      humidity: null,
    },
  };

  if (tokens.length === 0) {
    result.version = 'empty';
    return result;
  }

  if (tokens.length >= 5) {
    // V2: field_1 = score, field_2 = MQ135, field_3 = MQ137,
    // field_4 = temperature, field_5 = humidity.
    result.version = 'v2';
    result.parsed.score = toFiniteNumber(tokens[0]);
    result.parsed.mq135 = toFiniteNumber(tokens[1]);
    result.parsed.mq137 = toFiniteNumber(tokens[2]);
    result.parsed.temperature = toFiniteNumber(tokens[3]);
    result.parsed.humidity = toFiniteNumber(tokens[4]);
  } else if (tokens.length === 2) {
    // legacy V1: "Score,Voltage" — no environmental fields.
    result.version = 'legacy_v1';
    result.parsed.score = toFiniteNumber(tokens[0]);
  }

  return result;
};

module.exports = {
  parseSensorPayload,
  toFiniteNumber,
};
