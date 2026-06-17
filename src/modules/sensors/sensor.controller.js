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

const postRegisterSensor = async (req, res, next) => {
  try {
    const data = await sensorService.registerSensor(req);
    return sendSuccess(res, {
      statusCode: data.created ? 201 : 200,
      message: data.created ? 'Sensor registered successfully' : 'Sensor already registered',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postAttachSensor = async (req, res, next) => {
  try {
    const data = await sensorService.attachSensor(req);
    return sendSuccess(res, {
      statusCode: data.created ? 201 : 200,
      message: data.alreadyAttached ? 'Sensor already attached' : 'Sensor attached successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postReplaceSensor = async (req, res, next) => {
  try {
    const data = await sensorService.replaceSensor(req);
    return sendSuccess(res, {
      message: 'Sensor replaced successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postDetachSensor = async (req, res, next) => {
  try {
    const data = await sensorService.detachSensor(req);
    return sendSuccess(res, {
      message: 'Sensor detached successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletLatestReading = async (req, res, next) => {
  try {
    const data = await sensorService.getToiletLatestReading(req);
    return sendSuccess(res, {
      message: 'Latest toilet sensor reading fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletReadingHistory = async (req, res, next) => {
  try {
    const result = await sensorService.getToiletReadingHistory(req);
    return sendSuccess(res, {
      message: 'Toilet sensor history fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletReadingSummary = async (req, res, next) => {
  try {
    const data = await sensorService.getToiletReadingSummary(req);
    return sendSuccess(res, {
      message: 'Toilet sensor summary fetched successfully',
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
  postRegisterSensor,
  postAttachSensor,
  postReplaceSensor,
  postDetachSensor,
  getToiletLatestReading,
  getToiletReadingHistory,
  getToiletReadingSummary,
  getSensors,
  getSensorReadings,
  getFacilityLiveMetrics,
  getLiveAlerts,
};
