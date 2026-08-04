const AI_SCORING_POLICY_VERSION = 'tenant-ai-scoring-v1-strict-alias';
// `high` is retained only as a stored/API compatibility alias for `strict`.
const AI_SCORING_MODES = new Set(['light', 'medium', 'strict', 'high']);
const DEFAULT_AI_SCORING_MODE = 'medium';

// Medium preserves the established sanitation result. The other policies change
// the evidence penalty, never the AI's factual detection pass.
const AI_SCORING_POLICIES = Object.freeze({
  light: { minor: 0.2, moderate: 0.65, major: 1, critical: 1.1 },
  medium: { minor: 0.75, moderate: 1, major: 1.25, critical: 1.45 },
  strict: { minor: 1.15, moderate: 1.45, major: 1.7, critical: 2 },
});

const SEVERITY_PENALTIES = Object.freeze({ minor: 8, moderate: 20, major: 38, critical: 70 });
const CRITICAL_KEYWORDS = /feces|faeces|human.?waste|sewage|biohazard|blood|needle|overflow|blocked|unusable|exposed.{0,12}electric|structural.{0,12}hazard|pest|maggot/i;
const UNUSABLE_KEYWORDS = /overflow|sewage|blocked|unusable|no usable water|electrical|structural|multiple essential/i;
const BIOHAZARD_KEYWORDS = /feces|faeces|human.?waste|sewage|biohazard|blood|needle/i;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) => Number(Number(value).toFixed(2));

const resolveAiScoringMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'high') return 'strict';
  return AI_SCORING_MODES.has(mode) ? mode : DEFAULT_AI_SCORING_MODE;
};

const normalizeSeverity = (value, fallback = 'moderate') => {
  const severity = String(value || '').trim().toLowerCase();
  if (severity === 'low') return 'minor';
  if (severity === 'high') return 'major';
  if (AI_SCORING_POLICIES.medium[severity] !== undefined) return severity;
  return fallback;
};

const normaliseText = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const findingsFromStrictJson = (strictJson = {}, fallbackIssues = []) => {
  const supplied = Array.isArray(strictJson.findings) ? strictJson.findings : [];
  const findings = supplied
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      area: String(item.area || 'general').slice(0, 80),
      category: String(item.category || 'cleanliness').slice(0, 80),
      issue: String(item.issue || item.evidence || '').slice(0, 300),
      severity: normalizeSeverity(item.severity),
      confidence: Number.isFinite(Number(item.confidence)) ? clamp(Number(item.confidence), 0, 1) : null,
      safetyCritical: Boolean(item.safetyCritical || item.safety_critical || CRITICAL_KEYWORDS.test(`${item.issue || ''} ${item.evidence || ''}`)),
      evidence: String(item.evidence || '').slice(0, 500),
    }));
  if (findings.length > 0) return findings;

  const critical = strictJson.critical_findings || {};
  const criticalIssues = Object.entries(critical)
    .filter(([, active]) => active === true)
    .map(([issue]) => ({
      area: 'general', category: 'hygiene', issue: issue.replace(/_/g, ' '), severity: 'critical',
      confidence: strictJson.confidence_score, safetyCritical: true, evidence: issue.replace(/_/g, ' '),
    }));
  const issues = Array.isArray(strictJson.detected_issues) ? strictJson.detected_issues : fallbackIssues;
  return [
    ...criticalIssues,
    ...issues.map((issue) => {
      const text = String(issue || '');
      const criticalIssue = CRITICAL_KEYWORDS.test(text);
      return {
        area: 'general', category: 'cleanliness', issue: text,
        severity: criticalIssue ? 'critical' : normalizeSeverity(strictJson.severity_level, 'moderate'),
        confidence: strictJson.confidence_score, safetyCritical: criticalIssue, evidence: text,
      };
    }),
  ];
};

const deduplicateFindings = (findings = []) => {
  const byKey = new Map();
  for (const finding of findings) {
    const key = [normaliseText(finding.area), normaliseText(finding.category), normaliseText(finding.issue)]
      .join('|');
    if (!key.replaceAll('|', '')) continue;
    const current = byKey.get(key);
    if (!current || SEVERITY_PENALTIES[finding.severity] > SEVERITY_PENALTIES[current.severity]) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()];
};

const severityCounts = (findings) => findings.reduce((counts, finding) => {
  counts[finding.severity] += 1;
  return counts;
}, { minor: 0, moderate: 0, major: 0, critical: 0 });

const calculatePenalty = (findings, mode) => findings.reduce((total, finding) => {
  // Low confidence evidence still counts, but cannot carry the same weight as verified evidence.
  const confidence = finding.confidence === null ? 0.8 : Math.max(0.35, finding.confidence);
  return total + (SEVERITY_PENALTIES[finding.severity] * AI_SCORING_POLICIES[mode][finding.severity] * confidence);
}, 0);

const criticalCaps = (findings, mode) => {
  const text = findings.map((finding) => `${finding.issue} ${finding.evidence}`).join(' | ');
  const hasBiohazard = BIOHAZARD_KEYWORDS.test(text) && findings.some((finding) => finding.safetyCritical || finding.severity === 'critical');
  const hasUnusable = UNUSABLE_KEYWORDS.test(text) && findings.some((finding) => finding.safetyCritical || finding.severity === 'critical');
  if (hasBiohazard) return { cap: { light: 35, medium: 25, strict: 15 }[mode], reason: 'critical_biohazard' };
  if (hasUnusable) return { cap: { light: 30, medium: 20, strict: 10 }[mode], reason: 'critical_unusable_facility' };
  if (findings.some((finding) => finding.safetyCritical || finding.severity === 'critical')) {
    return { cap: { light: 40, medium: 30, strict: 20 }[mode], reason: 'critical_hygiene_or_safety' };
  }
  return null;
};

const scoreInspectionFindings = ({ mode, baseScore, findings, strictJson, fallbackIssues } = {}) => {
  const resolvedMode = resolveAiScoringMode(mode);
  const base = clamp(Number.isFinite(Number(baseScore)) ? Number(baseScore) : 100, 0, 100);
  const normalizedFindings = deduplicateFindings(
    Array.isArray(findings) && findings.length > 0 ? findings : findingsFromStrictJson(strictJson, fallbackIssues)
  );
  const selectedPenalty = calculatePenalty(normalizedFindings, resolvedMode);
  const mediumPenalty = calculatePenalty(normalizedFindings, DEFAULT_AI_SCORING_MODE);
  // Medium is intentionally the no-regression baseline; mode changes are calculated from evidence penalties.
  let finalScore = clamp(base + mediumPenalty - selectedPenalty, 0, 100);
  const cap = criticalCaps(normalizedFindings, resolvedMode);
  if (cap) finalScore = Math.min(finalScore, cap.cap);
  return {
    mode: resolvedMode,
    policyVersion: AI_SCORING_POLICY_VERSION,
    baseScore: round2(base),
    finalScore: round2(finalScore),
    totalPenalty: round2(selectedPenalty),
    severityCounts: severityCounts(normalizedFindings),
    findings: normalizedFindings,
    capsApplied: cap ? [cap] : [],
    fallbackUsed: resolveAiScoringMode(mode) !== String(mode || '').trim().toLowerCase(),
  };
};

module.exports = {
  AI_SCORING_POLICY_VERSION,
  AI_SCORING_MODES,
  DEFAULT_AI_SCORING_MODE,
  AI_SCORING_POLICIES,
  resolveAiScoringMode,
  findingsFromStrictJson,
  deduplicateFindings,
  scoreInspectionFindings,
};
