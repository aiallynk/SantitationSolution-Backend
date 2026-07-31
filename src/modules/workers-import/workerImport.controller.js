const { sendSuccess } = require('../../core/http/response');
const workerImportService = require('./workerImport.service');

const downloadTemplate = async (req, res, next) => {
  try {
    const result = await workerImportService.downloadTemplate(req);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    return res.status(200).send(result.content);
  } catch (error) {
    return next(error);
  }
};

const validateImportFile = async (req, res, next) => {
  try {
    const payload = await workerImportService.validateImportFile(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Worker import validation completed',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const confirmImport = async (req, res, next) => {
  try {
    const payload = await workerImportService.confirmImport(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Worker import confirmed successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const getHistory = async (req, res, next) => {
  try {
    const payload = await workerImportService.listHistory(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Worker import history fetched successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const getJobById = async (req, res, next) => {
  try {
    const payload = await workerImportService.getJobById(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Worker import job fetched successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const downloadResults = async (req, res, next) => {
  try {
    const result = await workerImportService.downloadResultsCsv(req);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    return res.status(200).send(result.content);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  downloadTemplate,
  validateImportFile,
  confirmImport,
  getHistory,
  getJobById,
  downloadResults,
};
