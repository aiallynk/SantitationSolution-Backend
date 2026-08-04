const {
  SensorConfidence,
  classifySensorEvidence,
} = require('../sensors/sensorEvidenceV2.service');

const EXPLAINABLE_SCORING_V2_VERSION = 'explainable-scoring-v2';
const EXPLAINABLE_SCORING_CONFIG_VERSION = '2026-08-04';
const EXPLAINABLE_SCORE_SCALE = 100;

const ScoringMode = Object.freeze({ LIGHT: 'LIGHT', MEDIUM: 'MEDIUM', STRICT: 'STRICT' });
const FindingSeverity = Object.freeze({ MINOR: 'MINOR', MODERATE: 'MODERATE', SEVERE: 'SEVERE', CRITICAL: 'CRITICAL' });

const MODE_CONFIG = Object.freeze({
  [ScoringMode.LIGHT]: Object.freeze({
    penaltyMultiplier: { MINOR: 0.65, MODERATE: 0.8, SEVERE: 0.9, CRITICAL: 1 },
    riskThresholds: { severe: 22, high: 38, medium: 65 },
    caps: { contaminated: 24, severePan: 48, multiSevere: 50 },
    minimumImprovementToClaimResolved: 15,
  }),
  [ScoringMode.MEDIUM]: Object.freeze({
    penaltyMultiplier: { MINOR: 1, MODERATE: 1, SEVERE: 1, CRITICAL: 1 },
    riskThresholds: { severe: 25, high: 42, medium: 70 },
    caps: { contaminated: 20, severePan: 42, multiSevere: 44 },
    minimumImprovementToClaimResolved: 25,
  }),
  [ScoringMode.STRICT]: Object.freeze({
    penaltyMultiplier: { MINOR: 1.2, MODERATE: 1.3, SEVERE: 1.4, CRITICAL: 1.5 },
    riskThresholds: { severe: 28, high: 46, medium: 75 },
    caps: { contaminated: 15, severePan: 35, multiSevere: 36 },
    minimumImprovementToClaimResolved: 40,
  }),
});

const ISSUE_TAXONOMY = Object.freeze([
  { code: 'VISIBLE_FAECAL_CONTAMINATION', patterns: ['feces', 'faeces', 'stool', 'human waste', 'potty'], basePenalty: 48, critical: true },
  { code: 'TOILET_PAN_DIRTY', patterns: ['dirty commode', 'dirty pan', 'dirty bowl', 'toilet pan', 'commode stain', 'pan stain'], basePenalty: 26, severePan: true },
  { code: 'TOILET_PAN_STAINING', patterns: ['bowl stain', 'pan staining', 'toilet staining'], basePenalty: 22, severePan: true },
  { code: 'FLOOR_HEAVY_STAINING', patterns: ['heavy floor stain', 'floor staining', 'strong dirt patch', 'dirty floor'], basePenalty: 20 },
  { code: 'MUD_OR_FOOTPRINTS', patterns: ['mud', 'footprint', 'muddy'], basePenalty: 14 },
  { code: 'GARBAGE_OR_WASTE', patterns: ['garbage', 'trash', 'waste', 'sanitary waste', 'overflowing bin'], basePenalty: 22 },
  { code: 'WATER_STAGNATION', patterns: ['waterlogging', 'water stagnation', 'dirty water', 'water pool', 'urine pooling'], basePenalty: 22 },
  { code: 'WET_FLOOR', patterns: ['wet floor', 'wetness'], basePenalty: 12 },
  { code: 'WALL_STAINING', patterns: ['wall stain', 'dirty wall'], basePenalty: 12 },
  { code: 'DRAIN_BLOCKAGE', patterns: ['blocked drain', 'drain blockage', 'overflow'], basePenalty: 26, critical: true },
  { code: 'URINE_STAINING', patterns: ['urine stain', 'urine'], basePenalty: 24 },
  { code: 'BROKEN_FIXTURE', patterns: ['broken fixture', 'broken toilet', 'damaged fixture'], basePenalty: 16 },
  { code: 'MISSING_WATER', patterns: ['missing water', 'no water'], basePenalty: 18 },
  { code: 'MISSING_SOAP', patterns: ['missing soap', 'no soap'], basePenalty: 8 },
  { code: 'MISSING_CLEANING_SUPPLIES', patterns: ['missing cleaning supplies', 'no cleaning supplies'], basePenalty: 7 },
  { code: 'POOR_LIGHTING', patterns: ['poor lighting', 'too dark'], basePenalty: 5 },
  { code: 'OBSTRUCTED_VIEW', patterns: ['obstructed', 'not visible', 'unclear'], basePenalty: 4 },
]);

const SEVERITY_ALIASES = Object.freeze({ low: 'MINOR', minor: 'MINOR', medium: 'MODERATE', moderate: 'MODERATE', high: 'SEVERE', major: 'SEVERE', severe: 'SEVERE', critical: 'CRITICAL' });
const SEVERITY_BASE_MULTIPLIER = Object.freeze({ MINOR: 0.55, MODERATE: 1, SEVERE: 1.45, CRITICAL: 1.8 });

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) => Number(Number(value).toFixed(2));

const resolveScoringMode = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'HIGH') return ScoringMode.STRICT;
  return Object.values(ScoringMode).includes(normalized) ? normalized : ScoringMode.MEDIUM;
};

const normalizeSeverity = (value) => SEVERITY_ALIASES[String(value || '').trim().toLowerCase()] || FindingSeverity.MODERATE;

const normalizeFinding = (finding = {}) => {
  const text = `${finding.code || ''} ${finding.label || ''} ${finding.issue || ''} ${finding.evidence || ''}`.toLowerCase();
  const taxonomy = ISSUE_TAXONOMY.find((definition) => definition.patterns.some((pattern) => text.includes(pattern)));
  return {
    code: String(finding.code || taxonomy?.code || 'UNCLASSIFIED_VISUAL_FINDING').trim().toUpperCase(),
    label: String(finding.label || finding.issue || taxonomy?.code || 'Visual hygiene finding').trim().slice(0, 180),
    evidence: String(finding.evidence || finding.issue || '').trim().slice(0, 900),
    severity: normalizeSeverity(finding.severity),
    confidence: Number.isFinite(Number(finding.confidence)) ? clamp(Number(finding.confidence), 0, 1) : 0.75,
    phase: String(finding.phase || '').trim().toUpperCase() || null,
    basePenalty: taxonomy?.basePenalty || 8,
    critical: Boolean(finding.safetyCritical || finding.safety_critical || taxonomy?.critical),
    severePan: Boolean(taxonomy?.severePan),
  };
};

const dedupeFindings = (findings = []) => {
  const rows = new Map();
  for (const supplied of Array.isArray(findings) ? findings : []) {
    if (!supplied || typeof supplied !== 'object') continue;
    const finding = normalizeFinding(supplied);
    const key = `${finding.code}|${finding.phase || ''}`;
    const existing = rows.get(key);
    if (!existing || SEVERITY_BASE_MULTIPLIER[finding.severity] > SEVERITY_BASE_MULTIPLIER[existing.severity]) rows.set(key, finding);
  }
  return [...rows.values()];
};

const sensorOperationalScore = (quality) => {
  // An environmental value participates only after the full capture protocol
  // marks it calibrated, warmed-up and stable. Low/unknown confidence is
  // retained as audit evidence but has zero scoring weight.
  if (!quality || quality.confidence !== SensorConfidence.HIGH || quality.validity !== 'VALID_STABLE') return null;
  const ppm = quality.evidence?.nearestSample?.ppm ?? quality.evidence?.captureWindow?.medianPpm;
  if (!Number.isFinite(Number(ppm))) return null;
  if (ppm <= 15) return 82;
  if (ppm <= 40) return 72;
  if (ppm <= 75) return 52;
  if (ppm <= 120) return 30;
  return 10;
};

const scoreExplainableInspection = ({ mode, findings = [], sensorEvidence = null, checklistScore = null } = {}) => {
  const resolvedMode = resolveScoringMode(mode);
  const config = MODE_CONFIG[resolvedMode];
  const resolvedFindings = dedupeFindings(findings);
  const reasons = [];
  let visualPenalty = 0;
  for (const finding of resolvedFindings) {
    const impact = finding.basePenalty * SEVERITY_BASE_MULTIPLIER[finding.severity] * config.penaltyMultiplier[finding.severity] * Math.max(0.45, finding.confidence);
    visualPenalty += impact;
    reasons.push({
      code: finding.code,
      severity: finding.severity,
      source: 'IMAGE',
      impactPoints: -round2(impact),
      explanation: finding.evidence || finding.label,
      phase: finding.phase,
    });
  }
  const visualScore = clamp(100 - visualPenalty, 0, 100);
  const sensor = classifySensorEvidence(sensorEvidence);
  const environmentalScore = sensorOperationalScore(sensor);
  const checklistProvided =
    checklistScore !== null &&
    checklistScore !== undefined &&
    String(checklistScore).trim() !== '';
  const checklist = checklistProvided && Number.isFinite(Number(checklistScore))
    ? clamp(Number(checklistScore), 0, 100)
    : null;
  const weights = environmentalScore === null
    ? { visualHygiene: 1, environmental: 0, checklist: 0 }
    : checklist === null
      ? { visualHygiene: 0.85, environmental: 0.15, checklist: 0 }
      : { visualHygiene: 0.75, environmental: 0.15, checklist: 0.1 };
  // Environmental evidence is a separate condition indicator. It may lower a
  // cleanliness result, but a low gas reading must never compensate for visible
  // dirt. Capping its contribution at the visual result preserves that rule.
  const boundedEnvironmentalContribution = environmentalScore === null
    ? 0
    : Math.min(visualScore, environmentalScore);
  let finalScore = visualScore * weights.visualHygiene + boundedEnvironmentalContribution * weights.environmental + (checklist || 0) * weights.checklist;

  const severeFindings = resolvedFindings.filter((finding) => finding.severity === FindingSeverity.SEVERE || finding.severity === FindingSeverity.CRITICAL);
  const capsApplied = [];
  const applyCap = (cap, reason) => {
    if (finalScore > cap) {
      finalScore = cap;
      capsApplied.push({ cap, reason });
    }
  };
  if (resolvedFindings.some((finding) => finding.critical || finding.code === 'VISIBLE_FAECAL_CONTAMINATION')) applyCap(config.caps.contaminated, 'critical_hygiene_condition');
  if (resolvedFindings.some((finding) => finding.severePan && finding.severity !== FindingSeverity.MINOR)) applyCap(config.caps.severePan, 'heavily_soiled_toilet_pan');
  if (severeFindings.length >= 3) applyCap(config.caps.multiSevere, 'multiple_severe_hygiene_findings');

  if (sensor.confidence === SensorConfidence.INVALID || sensor.validity !== 'VALID_STABLE') {
    reasons.push({
      code: `SENSOR_${sensor.validity}`,
      severity: 'WARNING',
      source: 'SENSOR',
      impactPoints: 0,
      explanation: `Environmental reading is ${String(sensor.validity || 'unavailable').toLowerCase().replaceAll('_', ' ')} and was not used to claim fresh air.`,
    });
  } else {
    reasons.push({
      code: `SENSOR_${sensor.classification}`,
      severity: 'INFO',
      source: 'SENSOR',
      impactPoints: 0,
      explanation: `Calibrated environmental reading classified as ${String(sensor.classification).toLowerCase().replaceAll('_', ' ')}.`,
    });
  }

  finalScore = round2(clamp(finalScore, 0, EXPLAINABLE_SCORE_SCALE));
  const thresholds = config.riskThresholds;
  const hygieneRisk = finalScore <= thresholds.severe ? 'SEVERE' : finalScore <= thresholds.high ? 'HIGH' : finalScore <= thresholds.medium ? 'MEDIUM' : 'LOW';
  const band = finalScore < 25 ? 'CRITICAL' : finalScore < 45 ? 'POOR' : finalScore < 70 ? 'FAIR' : finalScore < 85 ? 'GOOD' : 'EXCELLENT';
  return {
    score: finalScore,
    scale: EXPLAINABLE_SCORE_SCALE,
    mode: resolvedMode,
    scoringConfigVersion: EXPLAINABLE_SCORING_CONFIG_VERSION,
    scoringFormulaVersion: EXPLAINABLE_SCORING_V2_VERSION,
    band,
    hygieneRisk,
    confidence: sensor.confidence === SensorConfidence.INVALID ? 'PROVISIONAL' : 'HIGH',
    components: {
      visualHygiene: { score: round2(visualScore), weight: weights.visualHygiene },
      environmental: { score: environmentalScore, contribution: round2(boundedEnvironmentalContribution), weight: weights.environmental, sensorConfidence: sensor.confidence, validity: sensor.validity, classification: sensor.classification },
      checklist: { score: checklist, weight: weights.checklist },
    },
    reasons,
    capsApplied,
    findings: resolvedFindings,
    sensor,
    minimumImprovementToClaimResolved: config.minimumImprovementToClaimResolved,
  };
};

module.exports = {
  EXPLAINABLE_SCORING_V2_VERSION,
  EXPLAINABLE_SCORING_CONFIG_VERSION,
  EXPLAINABLE_SCORE_SCALE,
  ScoringMode,
  FindingSeverity,
  MODE_CONFIG,
  ISSUE_TAXONOMY,
  resolveScoringMode,
  dedupeFindings,
  scoreExplainableInspection,
};
