const { Op, QueryTypes } = require('sequelize');
const {
  sequelize,
  AiProcessingJob,
  InspectionMedia,
  ImageSession,
  Inspection,
} = require('../../models');
const { getQueueMetrics } = require('../../core/queue/queueManager');
const { ANALYSIS_QUEUE } = require('./analysis.queue');

const ANALYSIS_STALE_DEFAULT_MS = 3 * 60 * 1000;
const IMAGE_SESSION_STALE_DEFAULT_MS = 15 * 60 * 1000;

const resolveAnalysisStaleMs = () => {
  const value = Number(process.env.ANALYSIS_PROCESSING_STALE_MS || ANALYSIS_STALE_DEFAULT_MS);
  if (Number.isFinite(value) && value >= 30000) return value;
  return ANALYSIS_STALE_DEFAULT_MS;
};

const resolveImageSessionStaleMs = () => {
  const value = Number(process.env.IMAGE_SESSION_STALE_MS || IMAGE_SESSION_STALE_DEFAULT_MS);
  if (Number.isFinite(value) && value >= 60000) return value;
  return IMAGE_SESSION_STALE_DEFAULT_MS;
};

const loadScopedInspectionIds = async (req) => {
  const where = {};
  if (!req.user?.isSuperAdmin) {
    where.tenant_id = req.user?.tenantId || null;
  } else if (req.query?.tenantId) {
    where.tenant_id = req.query.tenantId;
  }

  const rows = await Inspection.findAll({
    where,
    attributes: ['id'],
    limit: 5000,
  });
  return rows.map((row) => row.id);
};

const getPipelineDiagnostics = async (req) => {
  const now = new Date();
  const analysisStaleCutoff = new Date(Date.now() - resolveAnalysisStaleMs());
  const imageSessionStaleCutoff = new Date(Date.now() - resolveImageSessionStaleMs());
  const inspectionIds = await loadScopedInspectionIds(req);
  const scopedInspectionWhere =
    inspectionIds.length > 0 ? { inspection_id: { [Op.in]: inspectionIds } } : { inspection_id: null };

  const [queue, jobStatusRows, mediaStateRows, staleRunningJobs, staleCreatedSessions, errorRows] =
    await Promise.all([
      getQueueMetrics(ANALYSIS_QUEUE),
      AiProcessingJob.findAll({
        where: scopedInspectionWhere,
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['status'],
        raw: true,
      }),
      InspectionMedia.findAll({
        where: scopedInspectionWhere,
        attributes: [
          'processing_state',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['processing_state'],
        raw: true,
      }),
      AiProcessingJob.count({
        where: {
          ...scopedInspectionWhere,
          status: 'running',
          [Op.or]: [
            { leased_until: { [Op.lt]: now } },
            { updated_at: { [Op.lt]: analysisStaleCutoff } },
          ],
        },
      }),
      ImageSession.count({
        where: {
          ...scopedInspectionWhere,
          status: 'created',
          [Op.or]: [
            { upload_url_expires_at: { [Op.lt]: now } },
            { updated_at: { [Op.lt]: imageSessionStaleCutoff } },
          ],
        },
      }),
      sequelize.query(
        `
          SELECT
            COALESCE(last_error_code, 'UNKNOWN') AS error_code,
            COUNT(*)::int AS count
          FROM inspection_media
          WHERE inspection_id = ANY(:inspectionIds)
            AND last_error_code IS NOT NULL
          GROUP BY COALESCE(last_error_code, 'UNKNOWN')
          ORDER BY count DESC
          LIMIT 20
        `,
        {
          replacements: { inspectionIds: inspectionIds.length > 0 ? inspectionIds : ['00000000-0000-0000-0000-000000000000'] },
          type: QueryTypes.SELECT,
        }
      ),
    ]);

  const jobStatusCounts = {};
  for (const row of jobStatusRows) {
    const key = String(row.status || 'unknown');
    jobStatusCounts[key] = Number(row.count || 0);
  }

  const mediaStateCounts = {};
  for (const row of mediaStateRows) {
    const key = String(row.processing_state || 'unknown');
    mediaStateCounts[key] = Number(row.count || 0);
  }

  return {
    generatedAt: new Date().toISOString(),
    queue,
    jobs: {
      byStatus: jobStatusCounts,
      staleRunning: Number(staleRunningJobs || 0),
    },
    media: {
      byProcessingState: mediaStateCounts,
      staleCreatedSessions: Number(staleCreatedSessions || 0),
      topErrorCodes: errorRows.map((row) => ({
        errorCode: String(row.error_code || 'UNKNOWN'),
        count: Number(row.count || 0),
      })),
    },
    thresholds: {
      analysisStaleMs: resolveAnalysisStaleMs(),
      imageSessionStaleMs: resolveImageSessionStaleMs(),
    },
  };
};

module.exports = {
  getPipelineDiagnostics,
};
