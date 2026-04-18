const { sendSuccess } = require('../../core/http/response');
const appUpdateService = require('./appUpdate.service');

const getAppUpdateMetadata = async (req, res, next) => {
  try {
    const data = appUpdateService.getAppUpdateMetadata(req);
    return sendSuccess(res, {
      message: 'App update metadata fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const downloadApkByVersion = async (req, res, next) => {
  try {
    const apk = appUpdateService.resolveApkDownload(req);

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${apk.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');

    return res.sendFile(apk.filePath);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAppUpdateMetadata,
  downloadApkByVersion,
};
