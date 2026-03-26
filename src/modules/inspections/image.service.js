const fs = require('fs');
const cloudinary = require('../../config/cloudinary');

const uploadInspectionImage = async (filePath, folder = 'ecovision/inspections') => {
  return cloudinary.uploader.upload(filePath, { folder });
};

const deleteTempFile = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Unable to delete temp file ${filePath}:`, error.message);
    }
  }
};

module.exports = {
  uploadInspectionImage,
  deleteTempFile,
};
