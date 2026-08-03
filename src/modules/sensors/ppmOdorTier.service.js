/**
 * Authoritative odor-tier policy for the wand's TGS gas concentration channel.
 *
 * The thresholds and score ranges come from `docs/change in ppm.pdf`:
 *   0-15     Excellent / Fresh      +10 to +20
 *   16-40    Good / Normal           +1 to +10
 *   41-75    Moderate / Noticeable   -1 to -5
 *   76-120   Bad / Heavy Odor        -5 to -10
 *   >120     Critical / Severe       -10 to -20
 *
 * Bounded bands interpolate within their documented range. The unbounded
 * critical band receives the documented maximum penalty, so a severe reading
 * cannot grow without limit or drive a visual score straight to zero.
 */

const PPM_ODOR_TIER_POLICY_VERSION = 'ppm-odor-tier-v1';

const PPM_ALERT_THRESHOLDS = Object.freeze({
  // 76 begins the Bad tier; 121 is the first whole-number reading above 120.
  warning: 76,
  critical: 121,
});

const PPM_ODOR_TIERS = Object.freeze([
  Object.freeze({
    key: 'excellent',
    min: 0,
    max: 15,
    label: 'Excellent / Fresh',
    cleanlinessRating: 'Best',
    scoreImpact: Object.freeze({ min: 10, max: 20 }),
  }),
  Object.freeze({
    key: 'good',
    min: 16,
    max: 40,
    label: 'Good / Normal',
    cleanlinessRating: 'Clean',
    scoreImpact: Object.freeze({ min: 1, max: 10 }),
  }),
  Object.freeze({
    key: 'moderate',
    min: 41,
    max: 75,
    label: 'Moderate / Noticeable',
    cleanlinessRating: 'Acceptable / Fair',
    scoreImpact: Object.freeze({ min: -5, max: -1 }),
  }),
  Object.freeze({
    key: 'bad',
    min: 76,
    max: 120,
    label: 'Bad / Heavy Odor',
    cleanlinessRating: 'Bad',
    scoreImpact: Object.freeze({ min: -10, max: -5 }),
  }),
  Object.freeze({
    key: 'critical',
    min: 120,
    max: null,
    minExclusive: true,
    label: 'Critical / Severe',
    cleanlinessRating: 'Critical / Unusable',
    scoreImpact: Object.freeze({ min: -20, max: -10 }),
  }),
]);

const toFinitePpm = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const interpolate = (value, start, end, startImpact, endImpact) => {
  if (start === end) return Math.round(startImpact);
  const progress = Math.min(Math.max((value - start) / (end - start), 0), 1);
  return Math.round(startImpact + (endImpact - startImpact) * progress);
};

const resolvePpmOdorTier = (value) => {
  const ppm = toFinitePpm(value);
  if (ppm === null) return null;

  if (ppm <= 15) {
    return {
      ...PPM_ODOR_TIERS[0],
      ppm,
      scoreAdjustment: interpolate(ppm, 0, 15, 20, 10),
    };
  }
  if (ppm <= 40) {
    return {
      ...PPM_ODOR_TIERS[1],
      ppm,
      scoreAdjustment: interpolate(ppm, 16, 40, 10, 1),
    };
  }
  if (ppm <= 75) {
    return {
      ...PPM_ODOR_TIERS[2],
      ppm,
      scoreAdjustment: interpolate(ppm, 41, 75, -1, -5),
    };
  }
  if (ppm <= 120) {
    return {
      ...PPM_ODOR_TIERS[3],
      ppm,
      scoreAdjustment: interpolate(ppm, 76, 120, -5, -10),
    };
  }
  return {
    ...PPM_ODOR_TIERS[4],
    ppm,
    scoreAdjustment: -20,
  };
};

module.exports = {
  PPM_ODOR_TIER_POLICY_VERSION,
  PPM_ALERT_THRESHOLDS,
  PPM_ODOR_TIERS,
  resolvePpmOdorTier,
};
