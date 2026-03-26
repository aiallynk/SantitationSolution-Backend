const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const inspectionController = require('./inspection.controller');
const { protect, restrictTo } = require('../../core/middleware/auth');
const AppError = require('../../core/errors/AppError');
const { validate } = require('../../core/middleware/validate');
const {
  validateSubmitInspection,
  validateInspectionListQuery,
  validateRecentQuery,
  validateInspectionIdParam,
} = require('./inspection.validator');

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '');
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `inspection-${uniqueSuffix}${extension}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    cb(null, true);
    return;
  }

  cb(new AppError('Only image files are allowed', 400));
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.post(
  '/upload',
  protect,
  restrictTo('WORKER'),
  upload.single('image'),
  inspectionController.uploadLegacyInspection
);

router.post(
  '/submit',
  protect,
  restrictTo('WORKER'),
  upload.fields([
    { name: 'beforeImage', maxCount: 1 },
    { name: 'afterImage', maxCount: 1 },
  ]),
  validate(validateSubmitInspection),
  inspectionController.submitInspection
);

router.get(
  '/my',
  protect,
  restrictTo('WORKER'),
  validate(validateInspectionListQuery),
  inspectionController.getMyInspections
);

router.get(
  '/recent',
  protect,
  restrictTo('ADMIN'),
  validate(validateRecentQuery),
  inspectionController.getRecentInspections
);

router.get(
  '/:id',
  protect,
  restrictTo('ADMIN'),
  validate(validateInspectionIdParam),
  inspectionController.getInspectionById
);

router.get(
  '/',
  protect,
  restrictTo('ADMIN'),
  validate(validateInspectionListQuery),
  inspectionController.getAllInspections
);

module.exports = router;
