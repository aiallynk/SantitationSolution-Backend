const { sendSuccess } = require('../../core/http/response');
const { enqueueInspectionAnalysis } = require('./analysis.queue');
const { getAnalysisResult, getInspectionAnalysisTrend } = require('./analysis.service');

const postRunAnalysis = async (req, res, next) => {
  try {
    const inspectionId = req.params.inspectionId;
    const enqueueResult = await enqueueInspectionAnalysis({
      inspectionId,
      requestContext: {
        user: req.user,
        requestId: req.requestId,
      },
    });
    return sendSuccess(res, {
      statusCode: 202,
      message: 'Inspection analysis scheduled',
      data: { inspectionId, ...enqueueResult },
    });
  } catch (error) {
    return next(error);
  }
};

const postReprocessAnalysis = async (req, res, next) => {
  try {
    const inspectionId = req.params.inspectionId;
    const enqueueResult = await enqueueInspectionAnalysis({
      inspectionId,
      requestContext: {
        user: req.user,
        requestId: req.requestId,
        reprocess: true,
      },
    });
    return sendSuccess(res, {
      statusCode: 202,
      message: 'Inspection analysis reprocess scheduled',
      data: { inspectionId, reprocess: true, ...enqueueResult },
    });
  } catch (error) {
    return next(error);
  }
};

const getInspectionAnalysisResult = async (req, res, next) => {
  try {
    const data = await getAnalysisResult(req.params.inspectionId, req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Inspection analysis status fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getInspectionAnalysisTrendData = async (req, res, next) => {
  try {
    const data = await getInspectionAnalysisTrend(req.params.inspectionId, req, {
      limit: req.query.limit,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Inspection analysis trend fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postAnalysisWebhook = async (req, res, next) => {
  try {
    // Placeholder endpoint for external AI providers.
    return sendSuccess(res, {
      statusCode: 202,
      message: 'Webhook received',
      data: {
        accepted: true,
        receivedAt: new Date().toISOString(),
        payload: req.body,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  postRunAnalysis,
  postReprocessAnalysis,
  getInspectionAnalysisResult,
  getInspectionAnalysisTrendData,
  postAnalysisWebhook,
};
