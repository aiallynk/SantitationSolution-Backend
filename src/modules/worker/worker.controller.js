const { sendSuccess } = require('../../core/http/response');
const workerHeartbeatService = require('../automation/workerHeartbeat.service');

const postHeartbeat = async (req, res, next) => {
  try {
    const data = await workerHeartbeatService.createWorkerHeartbeat(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Worker heartbeat recorded successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  postHeartbeat,
};
