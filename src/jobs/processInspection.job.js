const { processInspection } = require('../modules/inspections/processing.service');

const queueInspectionProcessing = (inspectionId) => {
  setImmediate(() => {
    processInspection(inspectionId).catch((error) => {
      console.error(`Failed to process inspection ${inspectionId}:`, error.message);
    });
  });
};

module.exports = {
  queueInspectionProcessing,
};
