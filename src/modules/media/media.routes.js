const express = require('express');
const mediaController = require('./media.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { createImageDiskUpload } = require('./uploadPolicy');

const router = express.Router();

const upload = createImageDiskUpload({
  filenamePrefix: 'media',
});

router.use('/media', protect);

router.post('/media/upload-init', requirePermissions('inspection.create'), mediaController.postUploadInit);
router.post(
  '/media/upload-complete',
  requirePermissions('inspection.create'),
  upload.single('file'),
  mediaController.postUploadComplete
);
router.get('/media/:id', requirePermissions('dashboard.read'), mediaController.getMediaById);
router.delete('/media/:id', requirePermissions('inspection.review'), mediaController.deleteMedia);

module.exports = router;
