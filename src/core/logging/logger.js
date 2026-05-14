const util = require('util');
const { runtimeConfig } = require('../../config/runtime');

const LOG_LEVELS = {
  error: 10,
  warn: 20,
  info: 30,
  debug: 40,
};

const DEFAULT_LEVEL = runtimeConfig.isProduction ? 'info' : 'debug';
const configuredLevel = String(runtimeConfig.logging.level || DEFAULT_LEVEL)
  .trim()
  .toLowerCase();
const activeLevel = Object.prototype.hasOwnProperty.call(LOG_LEVELS, configuredLevel)
  ? configuredLevel
  : DEFAULT_LEVEL;
const activeLevelWeight = LOG_LEVELS[activeLevel];
const serviceName = String(
  runtimeConfig.logging.serviceName || 'sanitation-backend'
)
  .trim()
  .slice(0, 100);

const logFormat = runtimeConfig.logging.format === 'json' ? 'json' : 'pretty';

const REDACT_KEY_PATTERN =
  /(pass(word)?|secret|token|authorization|cookie|api[_-]?key|jwt|refresh|access|session|credential|db[_-]?(pass|url))/i;
const REDACTED_VALUE = '[REDACTED]';

let consoleBridgeInstalled = false;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const sanitizeValue = (value, key = '', depth = 0) => {
  if (depth > 5) {
    return '[TRUNCATED]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (key && REDACT_KEY_PATTERN.test(String(key))) {
    return REDACTED_VALUE;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(runtimeConfig.isProduction ? {} : { stack: value.stack }),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeValue(item, '', depth + 1));
  }

  if (isPlainObject(value)) {
    const out = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      out[nestedKey] = sanitizeValue(nestedValue, nestedKey, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string') {
    if (value.length > 3000) {
      return `${value.slice(0, 3000)}...[TRUNCATED]`;
    }
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value;
};

const RESERVED_PAYLOAD_KEYS = new Set(['ts', 'level', 'service', 'msg', 'meta']);

const pad2 = (n) => String(n).padStart(2, '0');
const shortLocalTime = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, '0')}`;
};

const compactScalar = (value, maxLen = 160) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const t = value.replace(/\s+/g, ' ').trim();
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return compactScalar(value.message, maxLen);
  if (isPlainObject(value) || Array.isArray(value)) {
    try {
      const s = JSON.stringify(value);
      return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
    } catch {
      return '[Object]';
    }
  }
  return String(value).slice(0, maxLen);
};

/** For HTTP summary lines, omit meta keys already shown in `msg`. */
const stripHttpMetaDuplicates = (msg, meta) => {
  if (!meta || !isPlainObject(meta)) return meta;
  const m = String(msg || '');
  if (!/^(Slow )?(HEAD|GET|POST|PUT|PATCH|DELETE|OPTIONS) /.test(m)) return meta;
  const { method: _m, path: _p, status: _s, durationMs: _d, ...rest } = meta;
  return rest;
};

/** Flatten meta for a short trailing segment (pretty mode). */
const formatMetaSuffix = (msg, meta, maxTotal = 420) => {
  if (meta === null || meta === undefined) return '';
  const metaUse = stripHttpMetaDuplicates(msg, meta);
  const m = metaUse;
  if (!isPlainObject(m) && !Array.isArray(m)) {
    const s = compactScalar(m, 200);
    return s ? ` ${s}` : '';
  }
  if (Array.isArray(m)) {
    return ` ${compactScalar(m, maxTotal)}`;
  }

  const orderedKeys = [
    'method',
    'path',
    'status',
    'durationMs',
    'requestId',
    'tenantId',
    'userId',
    'ip',
    'code',
    'signal',
    'intervalMs',
    'error',
    'reason',
  ];
  const seen = new Set();
  const parts = [];

  const pushPair = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    const key = String(k).replace(/\s+/g, '_');
    let strVal;
    if (isPlainObject(v) && v.message) strVal = compactScalar(v.message, 120);
    else if (isPlainObject(v)) strVal = compactScalar(v, 100);
    else strVal = compactScalar(v, 140);
    if (!strVal) return;
    parts.push(`${key}=${strVal}`);
  };

  for (const k of orderedKeys) {
    if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
    pushPair(k, m[k]);
    seen.add(k);
  }
  for (const [k, v] of Object.entries(m)) {
    if (seen.has(k)) continue;
    pushPair(k, v);
  }

  let out = parts.join(' ');
  if (out.length > maxTotal) out = `${out.slice(0, maxTotal)}…`;
  return out ? ` | ${out}` : '';
};

const pruneNullish = (obj) => {
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === undefined) delete out[k];
  }
  if (out.meta && isPlainObject(out.meta)) {
    const m = { ...out.meta };
    for (const k of Object.keys(m)) {
      if (m[k] === null || m[k] === undefined) delete m[k];
    }
    if (Object.keys(m).length === 0) delete out.meta;
    else out.meta = m;
  }
  return out;
};

const levelAnsi = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};
const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';

const useAnsi =
  logFormat === 'pretty' &&
  !process.env.NO_COLOR &&
  String(process.env.FORCE_COLOR || '').trim() !== '0' &&
  (process.stdout.isTTY ||
    process.stderr.isTTY ||
    ['1', 'true', '2', '3'].includes(String(process.env.FORCE_COLOR || '').trim().toLowerCase()));

const colorizeLevel = (level, text) => {
  if (!useAnsi) return text;
  const open = levelAnsi[level] || '';
  if (!open) return text;
  return `${open}${text}${ANSI_RESET}`;
};

const formatPrettyLine = (payload) => {
  const { ts, level, msg, meta, service, ...rest } = payload;
  const time = shortLocalTime(ts);
  const lvl = String(level || '?').toUpperCase().padEnd(5);
  const lvlColored = colorizeLevel(String(level || '').toLowerCase(), lvl);
  let line = `[${time}] ${lvlColored} ${msg}`;

  const extra = [];
  for (const [k, v] of Object.entries(rest)) {
    if (RESERVED_PAYLOAD_KEYS.has(k)) continue;
    extra.push(`${k}=${compactScalar(v, 120)}`);
  }
  if (extra.length) {
    const suffix = extra.join(' ');
    line += useAnsi ? ` ${ANSI_DIM}| ${suffix}${ANSI_RESET}` : ` | ${suffix}`;
  }
  line += formatMetaSuffix(msg, meta);
  return `${line}\n`;
};

const formatJsonLine = (payload) => JSON.stringify(pruneNullish(payload));

const writeLine = (level, payload) => {
  const text = logFormat === 'pretty' ? formatPrettyLine(payload) : `${formatJsonLine(payload)}\n`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(text);
    return;
  }
  process.stdout.write(text);
};

const log = (level, message, meta = null, bindings = null) => {
  const normalizedLevel = String(level || '').toLowerCase();
  const levelWeight = LOG_LEVELS[normalizedLevel];
  if (!levelWeight || levelWeight > activeLevelWeight) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level: normalizedLevel,
    service: serviceName,
    msg: String(message || ''),
  };

  if (bindings && isPlainObject(bindings)) {
    Object.assign(payload, sanitizeValue(bindings));
  }

  if (meta !== null && meta !== undefined) {
    payload.meta = sanitizeValue(meta);
  }

  writeLine(normalizedLevel, payload);
};

const buildLogger = (bindings = null) => ({
  error(message, meta = null) {
    log('error', message, meta, bindings);
  },
  warn(message, meta = null) {
    log('warn', message, meta, bindings);
  },
  info(message, meta = null) {
    log('info', message, meta, bindings);
  },
  debug(message, meta = null) {
    log('debug', message, meta, bindings);
  },
  child(extraBindings = null) {
    const merged = {
      ...(isPlainObject(bindings) ? bindings : {}),
      ...(isPlainObject(extraBindings) ? extraBindings : {}),
    };
    return buildLogger(merged);
  },
});

const logger = buildLogger();

const installGlobalConsoleBridge = () => {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;

  const mapLevel = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug',
  };

  for (const [method, level] of Object.entries(mapLevel)) {
    // eslint-disable-next-line no-console
    console[method] = (...args) => {
      const text = util.format(...args);
      log(level, text);
    };
  }
};

module.exports = {
  logger,
  installGlobalConsoleBridge,
  sanitizeValue,
};
