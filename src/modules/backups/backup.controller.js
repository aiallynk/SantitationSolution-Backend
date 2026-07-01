const backupService = require('./backup.service');
const { sendSuccess } = require('../../core/http/response');

const wrap = (serviceFn, message) => async (req, res, next) => {
  try {
    const data = await serviceFn(req, res);
    if (res.headersSent) return undefined;
    return sendSuccess(res, { message, data });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getStats: wrap(backupService.getStats, 'Backup stats fetched successfully'),
  listJobs: wrap(backupService.listJobs, 'Backup jobs fetched successfully'),
  triggerManualBackup: wrap(backupService.triggerManualBackup, 'Backup job completed successfully'),
  getJobDetails: wrap(backupService.getJobDetails, 'Backup job fetched successfully'),
  createDownloadUrl: wrap(backupService.createDownloadUrl, 'Backup download URL created successfully'),
  downloadLocalFile: wrap(backupService.downloadLocalFile, 'Backup file downloaded successfully'),
  retryBackup: wrap(backupService.retryBackup, 'Backup retry completed successfully'),
  cleanupExpiredBackups: wrap(backupService.cleanupExpiredBackups, 'Expired backups cleaned up successfully'),
  listSchedules: wrap(backupService.listSchedules, 'Backup schedules fetched successfully'),
  upsertSchedule: wrap(backupService.upsertSchedule, 'Backup schedule saved successfully'),
  deleteSchedule: wrap(backupService.deleteSchedule, 'Backup schedule deleted successfully'),
  runScheduledBackups: wrap(backupService.runScheduledBackups, 'Scheduled backups completed successfully'),
};
