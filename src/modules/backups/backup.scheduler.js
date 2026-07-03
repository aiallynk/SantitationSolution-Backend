const { runtimeConfig } = require('../../config/runtime');
const { logger } = require('../../core/logging/logger');
const {
  reconcileBackupScheduleTimes,
  runBackupScheduleSweep,
} = require('./backup.service');

let schedulerTimer = null;
let schedulerRunning = false;

const runSweep = async () => {
  if (schedulerRunning) return { skipped: true, reason: 'already_running' };
  schedulerRunning = true;
  try {
    return await runBackupScheduleSweep({
      body: {},
      query: {},
      headers: {},
      ip: null,
      user: null,
    });
  } catch (error) {
    logger.error('Backup schedule sweep failed', { error: error.message });
    return { error: error.message };
  } finally {
    schedulerRunning = false;
  }
};

const startBackupScheduler = () => {
  if (schedulerTimer) return;
  const intervalMs = Number(runtimeConfig.backup.schedulerIntervalMs || 30_000);
  schedulerTimer = setInterval(() => {
    void runSweep();
  }, intervalMs);
  schedulerTimer.unref?.();
  setImmediate(() => {
    void reconcileBackupScheduleTimes()
      .then((result) => {
        logger.info('Backup schedules reconciled', result);
        return runSweep();
      })
      .catch((error) => {
        logger.error('Backup schedule reconciliation failed', { error: error.message });
      });
  });
  logger.info('Backup scheduler started', { intervalMs });
};

const stopBackupScheduler = () => {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
};

module.exports = {
  runSweep,
  startBackupScheduler,
  stopBackupScheduler,
};
