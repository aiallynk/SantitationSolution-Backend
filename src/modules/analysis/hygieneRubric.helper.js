const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) => Number(Number(value).toFixed(2));

const CAP_FECES_OR_EXTREME_BIO = 20;
const CAP_HEAVY_BOWL_UNSAFE = 25;
const CAP_FLOOR_WALLS_HEAVY = 30;
const CAP_VERY_DIRTY_USABLE = 40;
const CAP_MODERATE_MULTI_AREA = 60;
const CAP_GENERALLY_CLEAN_MINOR = 85;

/**
 * Apply critical penalty caps (minimum of applicable maximums).
 * Flags come from model vision booleans; all optional (default false).
 */
const applyCriticalPenaltyCaps = (score, flags = {}) => {
  const s = clamp(Number(score) || 0, 0, 100);
  const caps = [];
  if (flags.feces_or_extreme_bio_visible) caps.push(CAP_FECES_OR_EXTREME_BIO);
  if (flags.heavy_bowl_unsafe) caps.push(CAP_HEAVY_BOWL_UNSAFE);
  if (flags.floor_and_walls_heavy_dirty) caps.push(CAP_FLOOR_WALLS_HEAVY);
  if (flags.very_dirty_usable) caps.push(CAP_VERY_DIRTY_USABLE);
  if (flags.moderate_dirt_multiple_areas) caps.push(CAP_MODERATE_MULTI_AREA);
  if (flags.generally_clean_minor_only) caps.push(CAP_GENERALLY_CLEAN_MINOR);
  if (caps.length === 0) return round2(s);
  return round2(Math.min(s, ...caps));
};

const ratingLabelFromScore = (score) => {
  const s = clamp(Number(score) || 0, 0, 100);
  if (s <= 10) return 'Unusable';
  if (s <= 25) return 'Very Poor';
  if (s <= 40) return 'Poor';
  if (s <= 60) return 'Average';
  if (s <= 75) return 'Good';
  if (s <= 90) return 'Very Good';
  return 'Excellent';
};

const hygieneInspectionResultFromScore = (score) => {
  const s = clamp(Number(score) || 0, 0, 100);
  if (s <= 40) return 'Fail';
  if (s <= 65) return 'Needs Cleaning';
  if (s <= 85) return 'Pass';
  return 'Excellent';
};

const starRatingFromScore = (score) => {
  const s = clamp(Number(score) || 0, 0, 100);
  return Number((s / 20).toFixed(1));
};

const severityFromRubricScore = (score, flags = {}) => {
  if (flags.feces_or_extreme_bio_visible || Number(score) < 35) return 'high';
  if (Number(score) < 65) return 'medium';
  return 'low';
};

module.exports = {
  applyCriticalPenaltyCaps,
  ratingLabelFromScore,
  hygieneInspectionResultFromScore,
  starRatingFromScore,
  severityFromRubricScore,
};
