/**
 * Version-tolerant parser for BLE Sanitation Wand payloads.
 *
 * Confirmed firmware field sequence:
 *   - V3 (3 fields): field_1 = PPM (TGS gas concentration sensor),
 *     field_2 = temperature, field_3 = humidity.
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
 *   version: 'v3'|'unknown'|'empty',
 *   fields: Record<string, number|null>,   // field_1..field_N (numeric where possible)
 *   parsed: {
 *     ppm: number|null, temperature: number|null, humidity: number|null
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
      ppm: null,
      temperature: null,
      humidity: null,
    },
  };

  if (tokens.length === 0) {
    result.version = 'empty';
    return result;
  }

  if (tokens.length >= 3) {
    // V3: field_1 = PPM (TGS gas concentration), field_2 = temperature,
    // field_3 = humidity.
    result.version = 'v3';
    result.parsed.ppm = toFiniteNumber(tokens[0]);
    result.parsed.temperature = toFiniteNumber(tokens[1]);
    result.parsed.humidity = toFiniteNumber(tokens[2]);
  }

  return result;
};

module.exports = {
  parseSensorPayload,
  toFiniteNumber,
};
