const { Op } = require('sequelize');
const {
  Inspection,
  InspectionMedia,
  AiAnalysisResult,
  Alert,
  Facility,
} = require('../../models');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { createAuditLog } = require('../audit/audit.service');
const { isOpenAiAnalysisEnabled, analyzeInspectionWithOpenAI } = require('./openaiAnalysis.service');

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

const seeded = (seed, offset, min, max) => {
  const value = Math.sin(seed + offset * 11939) * 10000;
  const fraction = value - Math.floor(value);
  return Math.round(min + fraction * (max - min));
};

const deriveStatus = (score) => {
  if (score >= 80) return 'clean';
  if (score >= 60) return 'moderate';
  if (score >= 40) return 'poor';
  return 'critical';
};

const buildResult = (inspection, mediaCount) => {
  const seed = hashString(`${inspection.id}:${inspection.facility_id}:${inspection.captured_at}:${mediaCount}`);
  const cleanliness = clamp(seeded(seed, 1, 32, 95), 0, 100);
  const hygiene = clamp(seeded(seed, 2, 30, 94), 0, 100);
  const wetness = clamp(seeded(seed, 3, 25, 95), 0, 100);
  const stain = clamp(seeded(seed, 4, 20, 90), 0, 100);
  const litter = clamp(seeded(seed, 5, 24, 92), 0, 100);
  const odorRisk = clamp(seeded(seed, 6, 15, 95), 0, 100);

  const composite = Math.round(
    cleanliness * 0.35 +
      hygiene * 0.2 +
      wetness * 0.15 +
      stain * 0.1 +
      litter * 0.1 +
      (100 - odorRisk) * 0.1
  );

  return {
    modelName: process.env.ANALYSIS_MODEL_NAME || 'deterministic-rule-analyzer',
    modelVersion: process.env.ANALYSIS_MODEL_VERSION || 'v1',
    cleanlinessScore: cleanliness,
    hygieneScore: hygiene,
    odorRiskScore: odorRisk,
    wetnessScore: wetness,
    stainScore: stain,
    litterScore: litter,
    overallStatus: deriveStatus(composite),
    anomalyFlags: {
      low_cleanliness: cleanliness < 45,
      high_odor_risk: odorRisk > 70,
      wetness_concern: wetness < 45,
      stain_concern: stain < 45,
      litter_concern: litter < 45,
    },
    rawResult: {
      seed,
      mediaCount,
      algorithm: 'deterministic-rule-analyzer',
      generatedAt: new Date().toISOString(),
    },
  };
};

const maybeCreateAlert = async ({ inspection, result }) => {
  const shouldAlert =
    result.overallStatus === 'poor' ||
    result.overallStatus === 'critical' ||
    result.odorRiskScore > 75;

  if (!shouldAlert) {
    return null;
  }

  const severity =
    result.overallStatus === 'critical' || result.odorRiskScore > 85
      ? 'critical'
      : 'high';

  const openAlert = await Alert.findOne({
    where: {
      source_type: 'ai_analysis',
      source_id: inspection.id,
      status: {
        [Op.in]: ['open', 'acknowledged'],
      },
    },
  });
  if (openAlert) {
    return openAlert;
  }

  const alert = await Alert.create({
    tenant_id: inspection.tenant_id,
    alert_type: 'inspection_quality_breach',
    severity,
    source_type: 'ai_analysis',
    source_id: inspection.id,
    facility_id: inspection.facility_id,
    message: `Inspection ${inspection.id} flagged as ${result.overallStatus} (cleanliness ${result.cleanlinessScore}, odor risk ${result.odorRiskScore})`,
    status: 'open',
    created_at: new Date(),
    updated_at: new Date(),
  });

  eventBus.emit(EVENTS.ALERT_CREATED, {
    id: alert.id,
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    facilityId: inspection.facility_id,
    severity: alert.severity,
    status: alert.status,
    message: alert.message,
  });

  return alert;
};

const runInspectionAnalysis = async ({ inspectionId, req = null }) => {
  const inspection = await Inspection.findByPk(inspectionId);
  if (!inspection) {
    return null;
  }

  await inspection.update({
    processing_status: 'processing',
    updated_at: new Date(),
  });

  const mediaRows = await InspectionMedia.findAll({
    where: { inspection_id: inspection.id },
  });

  let result = null;
  if (isOpenAiAnalysisEnabled()) {
    try {
      result = await analyzeInspectionWithOpenAI({
        inspection,
        mediaRows,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`OpenAI analysis failed for inspection ${inspection.id}:`, error.message);
    }
  }

  if (!result) {
    result = buildResult(inspection, mediaRows.length);
  }

  const processedAt = new Date();

  const analysis = await AiAnalysisResult.create({
    inspection_id: inspection.id,
    model_name: result.modelName,
    model_version: result.modelVersion,
    cleanliness_score: result.cleanlinessScore,
    hygiene_score: result.hygieneScore,
    odor_risk_score: result.odorRiskScore,
    wetness_score: result.wetnessScore,
    stain_score: result.stainScore,
    litter_score: result.litterScore,
    anomaly_flags: result.anomalyFlags,
    raw_result: result.rawResult,
    processed_at: processedAt,
  });

  await inspection.update({
    processing_status: 'completed',
    submitted_at: inspection.submitted_at || processedAt,
    overall_status: result.overallStatus,
    updated_at: processedAt,
  });

  await maybeCreateAlert({ inspection, result });

  eventBus.emit(EVENTS.ANALYSIS_COMPLETED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    facilityId: inspection.facility_id,
    result: {
      id: analysis.id,
      cleanlinessScore: result.cleanlinessScore,
      hygieneScore: result.hygieneScore,
      odorRiskScore: result.odorRiskScore,
      wetnessScore: result.wetnessScore,
      stainScore: result.stainScore,
      litterScore: result.litterScore,
      overallStatus: result.overallStatus,
      processedAt,
    },
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: 'completed',
    overallStatus: result.overallStatus,
  });

  try {
    const facilityMetrics = await getFacilityMetrics(inspection.facility_id, {
      user: { isSuperAdmin: true, tenantId: inspection.tenant_id },
    });
    if (facilityMetrics) {
      eventBus.emit(EVENTS.FACILITY_METRICS_UPDATED, {
        facilityId: inspection.facility_id,
        tenantId: inspection.tenant_id,
        metrics: facilityMetrics,
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to emit facility metrics update:', error.message);
  }

  await createAuditLog({
    req,
    actorUserId: req?.user?.id || inspection.inspector_user_id,
    tenantId: inspection.tenant_id,
    action: 'analysis.inspection_run',
    entityType: 'inspection',
    entityId: inspection.id,
    details: {
      analysisId: analysis.id,
      overallStatus: result.overallStatus,
    },
  });

  return analysis;
};

const getAnalysisResult = async (inspectionId, req) => {
  const inspection = await Inspection.findByPk(inspectionId);
  if (!inspection) {
    return null;
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    return null;
  }

  const analysis = await AiAnalysisResult.findOne({
    where: { inspection_id: inspectionId },
    order: [['processed_at', 'DESC']],
  });

  if (!analysis) {
    return {
      inspectionId,
      processingStatus: inspection.processing_status,
      result: null,
    };
  }

  return {
    inspectionId,
    processingStatus: inspection.processing_status,
    result: {
      id: analysis.id,
      modelName: analysis.model_name,
      modelVersion: analysis.model_version,
      cleanlinessScore: Number(analysis.cleanliness_score),
      hygieneScore: Number(analysis.hygiene_score),
      odorRiskScore: Number(analysis.odor_risk_score),
      wetnessScore: Number(analysis.wetness_score),
      stainScore: Number(analysis.stain_score),
      litterScore: Number(analysis.litter_score),
      anomalyFlags: analysis.anomaly_flags || {},
      rawResult: analysis.raw_result || {},
      processedAt: analysis.processed_at,
      overallStatus: inspection.overall_status,
    },
  };
};

const getInspectionAnalysisTrend = async (inspectionId, req, options = {}) => {
  const inspection = await Inspection.findByPk(inspectionId);
  if (!inspection) {
    return null;
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    return null;
  }

  const limit = Math.min(Math.max(Number(options.limit || 25), 3), 60);
  const rows = await AiAnalysisResult.findAll({
    where: { inspection_id: inspectionId },
    order: [['processed_at', 'ASC']],
    limit,
  });

  const points = rows.map((row, index) => {
    const stainScore = Number(row.stain_score || 0);
    const litterScore = Number(row.litter_score || 0);
    const wetnessScore = Number(row.wetness_score || 0);
    const concernScore = Number((((100 - stainScore) + (100 - litterScore) + (100 - wetnessScore)) / 3).toFixed(2));

    return {
      index: index + 1,
      analysisId: row.id,
      processedAt: row.processed_at,
      stainScore,
      litterScore,
      wetnessScore,
      concernScore,
      cleanlinessScore: Number(row.cleanliness_score || 0),
      hygieneScore: Number(row.hygiene_score || 0),
    };
  });

  return {
    inspectionId,
    tenantId: inspection.tenant_id,
    points,
  };
};

const getFacilityMetrics = async (facilityId, req) => {
  const facility = await Facility.findByPk(facilityId);
  if (!facility) {
    return null;
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    return null;
  }

  const inspections = await Inspection.findAll({
    where: {
      facility_id: facilityId,
      processing_status: 'completed',
    },
    order: [['captured_at', 'DESC']],
    limit: 25,
    include: [{ model: AiAnalysisResult }],
  });

  const count = inspections.length;
  const avgCleanliness =
    count === 0
      ? 0
      : inspections.reduce((sum, item) => {
          const latest = (item.AiAnalysisResults || [])[0];
          return sum + Number(latest?.cleanliness_score || 0);
        }, 0) / count;

  return {
    facilityId,
    facilityName: facility.name,
    recentInspections: count,
    averageCleanliness: Number(avgCleanliness.toFixed(2)),
    latestOverallStatus: inspections[0]?.overall_status || null,
  };
};

module.exports = {
  runInspectionAnalysis,
  getAnalysisResult,
  getInspectionAnalysisTrend,
  getFacilityMetrics,
};
