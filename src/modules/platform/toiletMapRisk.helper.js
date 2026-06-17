const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const round2 = (value) => Number(Number(value).toFixed(2));

const toFiniteNumber = (value, fallback = null) => {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseDateMs = (value) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizePercent = (value, fallback = 0) =>
  clamp(toFiniteNumber(value, fallback) || 0, 0, 100);

const normalizeComplaintRisk = (activeComplaintsCount = 0) => {
  const count = Math.max(0, toFiniteNumber(activeComplaintsCount, 0) || 0);
  return clamp(count * 25, 0, 100);
};

const normalizeOverdueRisk = ({ lastInspectionAt = null, expectedInspectionDays = 7, now = Date.now() } = {}) => {
  const expectedDays = clamp(toFiniteNumber(expectedInspectionDays, 7) || 7, 1, 60);
  const inspectedMs = parseDateMs(lastInspectionAt);
  if (inspectedMs === null) return 70;

  const ageDays = Math.max(0, (now - inspectedMs) / (24 * 60 * 60 * 1000));
  if (ageDays <= expectedDays) {
    return clamp((ageDays / expectedDays) * 35, 0, 35);
  }
  return clamp(35 + ((ageDays - expectedDays) / expectedDays) * 65, 35, 100);
};

const normalizePriorityRisk = ({ priority = null, footfall = null } = {}) => {
  const priorityText = String(priority || '').trim().toLowerCase();
  if (['critical', 'very_high', 'very high'].includes(priorityText)) return 100;
  if (priorityText === 'high') return 80;
  if (priorityText === 'medium') return 55;
  if (priorityText === 'low') return 25;

  const numericFootfall = toFiniteNumber(footfall, null);
  if (numericFootfall !== null) {
    return clamp((numericFootfall / 500) * 100, 0, 100);
  }

  return 35;
};

const normalizeRepeatIssueRisk = ({ dirtyFrequency = 0, lowPerformanceFrequency = 0, recentFailedCount = 0 } = {}) => {
  const dirty = normalizePercent(dirtyFrequency, 0);
  const low = normalizePercent(lowPerformanceFrequency, 0);
  const failed = clamp((toFiniteNumber(recentFailedCount, 0) || 0) * 20, 0, 100);
  return Math.max(dirty, low, failed);
};

const freshnessConfidence = ({ lastInspectionAt = null, expectedInspectionDays = 7, now = Date.now() } = {}) => {
  const inspectedMs = parseDateMs(lastInspectionAt);
  if (inspectedMs === null) return 0.35;
  const expectedDays = clamp(toFiniteNumber(expectedInspectionDays, 7) || 7, 1, 60);
  const ageDays = Math.max(0, (now - inspectedMs) / (24 * 60 * 60 * 1000));
  if (ageDays <= expectedDays) return 1;
  return clamp(1 - ((ageDays - expectedDays) / (expectedDays * 4)) * 0.65, 0.35, 1);
};

const computeToiletRiskWeight = ({
  latestScore = null,
  activeComplaintsCount = 0,
  lastInspectionAt = null,
  expectedInspectionDays = 7,
  dirtyFrequency = 0,
  lowPerformanceFrequency = 0,
  recentFailedCount = 0,
  priority = null,
  footfall = null,
  now = Date.now(),
} = {}) => {
  const score = toFiniteNumber(latestScore, null);
  const aiRisk = score === null ? 45 : clamp(100 - score, 0, 100);
  const complaintRisk = normalizeComplaintRisk(activeComplaintsCount);
  const overdueRisk = normalizeOverdueRisk({ lastInspectionAt, expectedInspectionDays, now });
  const repeatIssueRisk = normalizeRepeatIssueRisk({
    dirtyFrequency,
    lowPerformanceFrequency,
    recentFailedCount,
  });
  const priorityRisk = normalizePriorityRisk({ priority, footfall });

  const riskWeight = clamp(
    0.5 * aiRisk +
      0.2 * complaintRisk +
      0.15 * overdueRisk +
      0.1 * repeatIssueRisk +
      0.05 * priorityRisk,
    0,
    100
  );

  return {
    riskWeight: round2(riskWeight),
    riskWeightNormalized: round2(riskWeight / 100),
    scoreConfidence: freshnessConfidence({ lastInspectionAt, expectedInspectionDays, now }),
    breakdown: {
      aiRisk: round2(aiRisk),
      complaintRisk: round2(complaintRisk),
      overdueRisk: round2(overdueRisk),
      repeatIssueRisk: round2(repeatIssueRisk),
      priorityRisk: round2(priorityRisk),
    },
  };
};

module.exports = {
  computeToiletRiskWeight,
  normalizeComplaintRisk,
  normalizeOverdueRisk,
  normalizePriorityRisk,
  normalizeRepeatIssueRisk,
};
