const { Op } = require('sequelize');
const Inspection = require('./inspection.model');
const Alert = require('../alerts/alert.model');

const SCORE_FIELDS = [
  'floorCleanliness',
  'wallCleanliness',
  'wetnessControl',
  'litterControl',
  'odourRisk',
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const hashString = (input) => {
  const text = String(input || '');
  let hash = 0;

  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
};

const seededFraction = (seed, offset = 0) => {
  const x = Math.sin(seed + (offset + 1) * 9973) * 10000;
  return x - Math.floor(x);
};

const seededInt = (seed, offset, min, max) => {
  const fraction = seededFraction(seed, offset);
  return Math.round(min + fraction * (max - min));
};

const average = (values) => {
  if (!values || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const deriveSeverity = (score) => {
  if (score <= 40) return 'critical';
  if (score <= 60) return 'poor';
  if (score <= 75) return 'moderate';
  if (score <= 90) return 'good';
  return 'excellent';
};

const generateBreakdown = (seed, targetBefore, targetAfter) => {
  const beforeValues = [];
  const afterValues = [];
  const breakdown = {};

  SCORE_FIELDS.forEach((field, index) => {
    const before = clamp(targetBefore + seededInt(seed, 10 + index, -10, 10), 25, 70);
    const after = clamp(
      Math.max(
        before + seededInt(seed, 20 + index, 12, 35),
        targetAfter + seededInt(seed, 30 + index, -8, 8)
      ),
      50,
      98
    );

    beforeValues.push(before);
    afterValues.push(after);

    breakdown[field] = {
      before,
      after,
      improvement: after - before,
    };
  });

  return {
    breakdown,
    beforeAverage: Math.round(average(beforeValues)),
    afterAverage: Math.round(average(afterValues)),
  };
};

const generateFindings = (result) => {
  const findings = [];
  const { scoreBreakdown } = result;

  if (scoreBreakdown.wetnessControl.before < 50) {
    findings.push('Wet floor detected before cleaning');
  }

  if (scoreBreakdown.litterControl.before < 55) {
    findings.push('Visible litter detected');
  }

  if (scoreBreakdown.wallCleanliness.improvement >= 12) {
    findings.push('Stain presence reduced after cleaning');
  }

  if (scoreBreakdown.odourRisk.improvement >= 12) {
    findings.push('Odour risk improved');
  }

  if (scoreBreakdown.floorCleanliness.improvement >= 15) {
    findings.push('Floor cleanliness improved significantly');
  }

  findings.push('Cleaning improvement verified');

  const uniqueFindings = [...new Set(findings)];
  return uniqueFindings.slice(0, 5);
};

const createProcessingResult = (inspection) => {
  const seedBase = hashString(
    `${inspection.id}:${inspection.toilet_code || ''}:${inspection.zone || ''}:${inspection.created_at}`
  );

  const targetBefore = seededInt(seedBase, 1, 30, 60);
  const targetAfter = clamp(
    Math.max(seededInt(seedBase, 2, 70, 95), targetBefore + seededInt(seedBase, 3, 14, 40)),
    70,
    95
  );

  const generated = generateBreakdown(seedBase, targetBefore, targetAfter);
  let scoreBefore = clamp(generated.beforeAverage, 30, 60);
  let scoreAfter = clamp(generated.afterAverage, 70, 95);

  if (scoreAfter - scoreBefore < 10) {
    scoreAfter = clamp(scoreBefore + 10, 70, 95);
  }

  const improvementScore = clamp(scoreAfter - scoreBefore, 0, 100);
  const overallScore = clamp(
    Math.round((scoreAfter * 0.7) + (improvementScore * 0.3)),
    0,
    100
  );

  const severity = deriveSeverity(overallScore);
  const result = {
    scoreBefore,
    scoreAfter,
    improvementScore,
    overallScore,
    severity,
    scoreBreakdown: generated.breakdown,
  };

  result.findings = generateFindings(result);
  return result;
};

const shouldCreateAlert = (result) => {
  return result.overallScore <= 60 || result.scoreAfter <= 60;
};

const getAlertSeverity = (result) => {
  if (result.overallScore <= 40 || result.scoreAfter <= 40) {
    return 'critical';
  }

  return 'poor';
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processInspection = async (inspectionId) => {
  let inspection;

  try {
    inspection = await Inspection.findByPk(inspectionId);
    if (!inspection) {
      return null;
    }

    if (inspection.status === 'completed') {
      return inspection;
    }

    if (inspection.status !== 'processing') {
      inspection.status = 'processing';
      await inspection.save();
    }

    const seed = hashString(`${inspection.id}:${inspection.toilet_code || ''}`);
    const delayMs = clamp(seededInt(seed, 99, 2000, 5000), 2000, 5000);
    await wait(delayMs);

    const result = createProcessingResult(inspection);

    await inspection.update({
      score_before: result.scoreBefore,
      score_after: result.scoreAfter,
      improvement_score: result.improvementScore,
      overall_score: result.overallScore,
      score: result.overallScore,
      severity: result.severity,
      findings_json: JSON.stringify(result.findings),
      score_breakdown_json: JSON.stringify(result.scoreBreakdown),
      status: 'completed',
      processed_at: new Date(),
    });

    if (shouldCreateAlert(result)) {
      const existingAlert = await Alert.findOne({
        where: {
          inspection_id: inspection.id,
          status: {
            [Op.in]: ['open', 'acknowledged'],
          },
        },
      });

      if (!existingAlert) {
        await Alert.create({
          inspection_id: inspection.id,
          severity: getAlertSeverity(result),
          status: 'open',
          message: `Inspection ${inspection.id} remains below cleanliness threshold (overall: ${result.overallScore}, after: ${result.scoreAfter})`,
        });
      }
    }

    return inspection;
  } catch (error) {
    if (inspection) {
      try {
        await inspection.update({ status: 'failed' });
      } catch (updateError) {
        console.error('Failed to mark inspection as failed:', updateError.message);
      }
    }

    console.error(`Inspection processing failed for ${inspectionId}:`, error.message);
    return null;
  }
};

module.exports = {
  processInspection,
  createProcessingResult,
  deriveSeverity,
};
