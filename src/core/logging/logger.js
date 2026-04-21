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

const writeLine = (level, payload) => {
  const text = `${JSON.stringify(payload)}\n`;
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
