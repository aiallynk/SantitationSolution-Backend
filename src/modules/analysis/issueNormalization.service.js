const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ');

const mapIssueText = (text) => {
  const value = normalizeText(text);
  if (!value) return null;

  if (
    value.includes('floor') ||
    value.includes('stain') ||
    value.includes('dirty floor') ||
    value.includes('mud')
  ) {
    return 'floor_stains';
  }

  if (
    value.includes('commode') ||
    value.includes('urinal') ||
    value.includes('toilet seat') ||
    value.includes('toilet bowl')
  ) {
    return 'commode_dirty';
  }

  if (
    value.includes('water') ||
    value.includes('wet') ||
    value.includes('puddle') ||
    value.includes('stagnation')
  ) {
    return 'water_stagnation';
  }

  if (
    value.includes('garbage') ||
    value.includes('waste') ||
    value.includes('litter') ||
    value.includes('trash')
  ) {
    return 'garbage_present';
  }

  if (value.includes('odor') || value.includes('smell')) {
    return 'odor_possible';
  }

  return null;
};

const normalizeIssueTags = ({
  aiIssues = [],
  floorCleanliness = null,
  commodeCleanliness = null,
  stainPresence = null,
  waterStagnation = null,
  garbagePresence = null,
  confidenceScore = null,
}) => {
  const tags = new Set();

  for (const issue of Array.isArray(aiIssues) ? aiIssues : []) {
    const mapped = mapIssueText(issue);
    if (mapped) tags.add(mapped);
  }

  if (Number.isFinite(Number(floorCleanliness)) && Number(floorCleanliness) < 55) {
    tags.add('floor_stains');
  }
  if (Number.isFinite(Number(commodeCleanliness)) && Number(commodeCleanliness) < 55) {
    tags.add('commode_dirty');
  }
  if (Number.isFinite(Number(waterStagnation)) && Number(waterStagnation) >= 45) {
    tags.add('water_stagnation');
  }
  if (garbagePresence === true) {
    tags.add('garbage_present');
  }
  if (
    Number.isFinite(Number(stainPresence)) &&
    Number(stainPresence) >= 55 &&
    !tags.has('floor_stains')
  ) {
    tags.add('floor_stains');
  }

  const confidence = Number(confidenceScore);
  if (Number.isFinite(confidence) && confidence < 0.65) {
    tags.add('odor_possible');
  }

  return Array.from(tags.values());
};

module.exports = {
  normalizeIssueTags,
};
