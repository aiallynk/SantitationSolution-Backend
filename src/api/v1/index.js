const express = require('express');

const authRoutes = require('../../modules/auth/auth.routes');
const authController = require('../../modules/auth/auth.controller');
const { validateUpdateMe } = require('../../modules/auth/auth.validator');
const userRoutes = require('../../modules/users/user.routes');
const platformRoutes = require('../../modules/platform/platform.routes');
const taskRoutes = require('../../modules/tasks/task.routes');
const inspectionRoutes = require('../../modules/inspections/inspection.routes');
const mediaRoutes = require('../../modules/media/media.routes');
const analysisRoutes = require('../../modules/analysis/analysis.routes');
const sensorRoutes = require('../../modules/sensors/sensor.routes');
const alertRoutes = require('../../modules/alerts/alert.routes');
const dashboardRoutes = require('../../modules/dashboard/dashboard.routes');
const supervisorRoutes = require('../../modules/supervisor/supervisor.routes');
const superAdminRoutes = require('../../modules/superAdmin/superAdmin.routes');
const reportRoutes = require('../../modules/reports/report.routes');
const complaintRoutes = require('../../modules/complaints/complaint.routes');
const notificationRoutes = require('../../modules/notifications/notification.routes');
const liveRoutes = require('../../modules/live/live.routes');
const auditRoutes = require('../../modules/audit/audit.routes');
const appUpdateRoutes = require('../../modules/appUpdate/appUpdate.routes');
const workerRoutes = require('../../modules/worker/worker.routes');
const consumptionRoutes = require('../../modules/consumption/consumption.routes');
const { protect } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');

const router = express.Router();

router.use('/auth', authRoutes);
router.use(appUpdateRoutes);
router.get('/me', protect, authController.getMe);
router.patch('/me', protect, validate(validateUpdateMe), authController.patchMe);
// Keep public complaint feedback endpoints reachable without auth.
router.use(complaintRoutes);
router.use(userRoutes);
router.use(platformRoutes);
router.use(taskRoutes);
router.use(inspectionRoutes);
router.use(mediaRoutes);
router.use(analysisRoutes);
router.use(sensorRoutes);
router.use(alertRoutes);
router.use(dashboardRoutes);
router.use(supervisorRoutes);
router.use('/super-admin', superAdminRoutes);
router.use(reportRoutes);
router.use(notificationRoutes);
router.use(liveRoutes);
router.use(auditRoutes);
router.use(workerRoutes);
router.use(consumptionRoutes);

module.exports = router;
