const { addJob, registerWorker } = require('../../core/queue/queueManager');
const { runInspectionAnalysis } = require('./analysis.service');

const ANALYSIS_QUEUE = 'inspection-analysis';

const enqueueInspectionAnalysis = async ({ inspectionId, requestContext = {} }) => {
  const queued = await addJob(
    ANALYSIS_QUEUE,
    'process-inspection',
    { inspectionId, requestContext },
    {}
  );

  if (queued) {
    return { queued: true };
  }

  // Fallback when Redis is not configured.
  setImmediate(async () => {
    try {
      await runInspectionAnalysis({ inspectionId, req: requestContext });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Inline analysis processing failed:', error.message);
    }
  });

  return { queued: false };
};

const registerAnalysisWorker = () => {
  registerWorker(ANALYSIS_QUEUE, async (job) => {
    await runInspectionAnalysis({
      inspectionId: job.data.inspectionId,
      req: job.data.requestContext || null,
    });
  });
};

module.exports = {
  ANALYSIS_QUEUE,
  enqueueInspectionAnalysis,
  registerAnalysisWorker,
};
