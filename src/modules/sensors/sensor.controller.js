const { sendSuccess } = require('../../core/http/response');
const sensorService = require('./sensor.service');

const postIngestion = async (req, res, next) => {
  try {
    const data = await sensorService.ingestSensorReading(req);
    return sendSuccess(res, {
      statusCode: 202,
      message: 'Sensor reading ingested successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getSensors = async (req, res, next) => {
  try {
    const result = await sensorService.listSensors(req);
    return sendSuccess(res, {
      message: 'Sensors fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getSensorReadings = async (req, res, next) => {
  try {
    const result = await sensorService.listSensorReadings(req);
    return sendSuccess(res, {
      message: 'Sensor readings fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getFacilityLiveMetrics = async (req, res, next) => {
  try {
    const data = await sensorService.getFacilityLiveMetrics(req);
    return sendSuccess(res, {
      message: 'Facility live metrics fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getLiveAlerts = async (req, res, next) => {
  try {
    const data = await sensorService.getLiveAlerts(req);
    return sendSuccess(res, {
      message: 'Live alerts fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  postIngestion,
  getSensors,
  getSensorReadings,
  getFacilityLiveMetrics,
  getLiveAlerts,
};
