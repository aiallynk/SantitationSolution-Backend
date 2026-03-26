const { queueInspectionProcessing } = require('./processInspection.job');

const processImageBackground = async (inspectionId) => {
  queueInspectionProcessing(inspectionId);
};

module.exports = {
  processImageBackground,
};
