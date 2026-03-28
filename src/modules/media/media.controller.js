const { sendSuccess } = require('../../core/http/response');
const mediaService = require('./media.service');

const postUploadInit = async (req, res, next) => {
  try {
    const data = await mediaService.uploadInit(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Media upload initialized',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postUploadComplete = async (req, res, next) => {
  try {
    const data = await mediaService.uploadComplete(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Media upload completed',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getMediaById = async (req, res, next) => {
  try {
    const data = await mediaService.getMediaById(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Media fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const deleteMedia = async (req, res, next) => {
  try {
    const data = await mediaService.deleteMedia(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Media deleted successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  postUploadInit,
  postUploadComplete,
  getMediaById,
  deleteMedia,
};
