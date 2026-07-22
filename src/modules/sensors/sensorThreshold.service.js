/**
 * Phase 2 — Sensor threshold evaluation engine.
 *
 * Pure, configuration-driven. Returns NORMAL / WARNING / CRITICAL for each
 * metric plus a list of typed alert candidates. Thresholds come from
 * `runtimeConfig.alerts.sensor` (env-configurable); callers may pass overrides
 * (e.g. future per-tenant settings). A `null` bound disables that check, so an
 * uncalibrated metric (e.g. the PPM gas channel) never produces misleading alerts.
 */

const { runtimeConfig } = require('../../config/runtime');

const STATUS = Object.freeze({ NORMAL: 'NORMAL', WARNING: 'WARNING', CRITICAL: 'CRITICAL' });

const SEVERITY_BY_STATUS = Object.freeze({
  [STATUS.WARNING]: 'medium',
  [STATUS.CRITICAL]: 'critical',
});

const RANK = Object.freeze({ NORMAL: 0, WARNING: 1, CRITICAL: 2 });

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

const getSensorThresholds = (overrides = {}) => {
  const base = runtimeConfig.alerts.sensor;
  // Shallow per-section merge so callers can override one metric without
  // re-specifying every bound.
  const merged = {};
  for (const key of Object.keys(base)) {
    merged[key] = { ...base[key], ...(overrides[key] || {}) };
  }
  return merged;
};

// value >= critical => CRITICAL; value >= warning => WARNING; else NORMAL.
const evalHighBound = (value, warning, critical) => {
  if (!isNum(value)) return { status: STATUS.NORMAL, threshold: null };
  if (isNum(critical) && value >= critical) return { status: STATUS.CRITICAL, threshold: critical };
  if (isNum(warning) && value >= warning) return { status: STATUS.WARNING, threshold: warning };
  return { status: STATUS.NORMAL, threshold: null };
};

// value <= critical => CRITICAL; value <= warning => WARNING; else NORMAL.
const evalLowBound = (value, warning, critical) => {
  if (!isNum(value)) return { status: STATUS.NORMAL, threshold: null };
  if (isNum(critical) && value <= critical) return { status: STATUS.CRITICAL, threshold: critical };
  if (isNum(warning) && value <= warning) return { status: STATUS.WARNING, threshold: warning };
  return { status: STATUS.NORMAL, threshold: null };
};

const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/**
 * @param {object} metrics  output of toSensorMetrics()
 * @param {object} [overrides]  partial threshold overrides
 * @returns {{
 *   overallStatus: string,
 *   metrics: Record<string, {status:string, value:number|null, threshold:number|null, direction:string}>,
 *   alerts: Array<{type:string, metric:string, status:string, severity:string, value:number, threshold:number, message:string}>
 * }}
 */
const evaluateSensorMetrics = (metrics = {}, overrides = {}) => {
  const t = getSensorThresholds(overrides);
  const perMetric = {};
  const alerts = [];
  let overall = STATUS.NORMAL;

  // Evaluate one metric that may breach a high bound and/or a low bound, each
  // mapping to a distinct alert type. Records a single perMetric entry (worse of
  // the two) and at most one alert (the breached direction).
  const evaluate = ({ key, value, unit, label, high, low }) => {
    const highResult = high ? evalHighBound(value, high.warning, high.critical) : { status: STATUS.NORMAL, threshold: null };
    const lowResult = low ? evalLowBound(value, low.warning, low.critical) : { status: STATUS.NORMAL, threshold: null };

    let breach = null;
    if (highResult.status !== STATUS.NORMAL) {
      breach = { direction: 'high', type: high.type, result: highResult };
    } else if (lowResult.status !== STATUS.NORMAL) {
      breach = { direction: 'low', type: low.type, result: lowResult };
    }

    const status = worse(highResult.status, lowResult.status);
    perMetric[key] = {
      status,
      value: isNum(value) ? value : null,
      threshold: breach ? breach.result.threshold : null,
      direction: breach ? breach.direction : 'high',
    };

    if (breach) {
      overall = worse(overall, breach.result.status);
      alerts.push({
        type: breach.type,
        metric: key,
        status: breach.result.status,
        severity: SEVERITY_BY_STATUS[breach.result.status],
        value,
        threshold: breach.result.threshold,
        message: `${label} ${breach.direction === 'low' ? 'below' : 'above'} ${breach.result.status.toLowerCase()} threshold: ${value}${unit} (limit ${breach.result.threshold}${unit})`,
      });
    }
  };

  evaluate({
    key: 'temperature',
    value: metrics.temperature,
    unit: 'C',
    label: 'Temperature',
    high: { warning: t.temperature.highWarningC, critical: t.temperature.highCriticalC, type: 'HIGH_TEMPERATURE' },
    low: { warning: t.temperature.lowWarningC, critical: t.temperature.lowCriticalC, type: 'LOW_TEMPERATURE' },
  });

  evaluate({
    key: 'humidity',
    value: metrics.humidity,
    unit: '%',
    label: 'Humidity',
    high: { warning: t.humidity.highWarningPct, critical: t.humidity.highCriticalPct, type: 'HIGH_HUMIDITY' },
    low: { warning: t.humidity.lowWarningPct, critical: t.humidity.lowCriticalPct, type: 'LOW_HUMIDITY' },
  });

  // Gas concentration (TGS sensor) — disabled unless operator-calibrated thresholds set.
  evaluate({
    key: 'ppm',
    value: metrics.ppm,
    unit: 'ppm',
    label: 'Gas Concentration (PPM)',
    high: { warning: t.ppm.warning, critical: t.ppm.critical, type: 'AIR_QUALITY_ALERT' },
  });

  // Battery — only when the device reports it.
  evaluate({
    key: 'battery',
    value: metrics.battery,
    unit: '%',
    label: 'Battery',
    low: { warning: t.battery.lowWarningPct, critical: t.battery.lowCriticalPct, type: 'LOW_BATTERY' },
  });

  return { overallStatus: overall, metrics: perMetric, alerts };
};

/**
 * Offline classification from the last-seen time (used by the offline-alert job
 * and supervisor widgets). Returns NORMAL / WARNING / CRITICAL + age in minutes.
 */
const evaluateOfflineStatus = (lastSeenAt, now = new Date(), overrides = {}) => {
  const t = getSensorThresholds(overrides).offline;
  const last = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(last.getTime())) {
    return { status: STATUS.NORMAL, minutes: null };
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - last.getTime()) / 60000));
  if (isNum(t.criticalMinutes) && minutes >= t.criticalMinutes) {
    return { status: STATUS.CRITICAL, minutes, threshold: t.criticalMinutes };
  }
  if (isNum(t.warningMinutes) && minutes >= t.warningMinutes) {
    return { status: STATUS.WARNING, minutes, threshold: t.warningMinutes };
  }
  return { status: STATUS.NORMAL, minutes };
};

module.exports = {
  STATUS,
  SEVERITY_BY_STATUS,
  getSensorThresholds,
  evaluateSensorMetrics,
  evaluateOfflineStatus,
};
