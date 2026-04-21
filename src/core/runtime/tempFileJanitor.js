const fs = require('fs');
const path = require('path');
const { logger } = require('../logging/logger');
const { runtimeConfig } = require('../../config/runtime');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_DELETE_PER_RUN = 500;

let janitorTimer = null;
let janitorRunning = false;

const tempRoot = path.join(
  process.cwd(),
  String(runtimeConfig.media.tempUploadSubdir || 'uploads/temp')
);

const janitorEnabled = () =>
  Boolean(runtimeConfig.media.tempFileJanitorEnabled);

const resolveIntervalMs = () => {
  const value = Number(runtimeConfig.media.tempFileJanitorIntervalMs || DEFAULT_INTERVAL_MS);
  if (Number.isFinite(value) && value >= 60_000) {
    return value;
  }
  return DEFAULT_INTERVAL_MS;
};

const resolveMaxAgeMs = () => {
  const value = Number(runtimeConfig.media.tempFileMaxAgeMs || DEFAULT_MAX_AGE_MS);
  if (Number.isFinite(value) && value >= 60_000) {
    return value;
  }
  return DEFAULT_MAX_AGE_MS;
};

const resolveMaxDeletePerRun = () => {
  const value = Number(runtimeConfig.media.tempFileJanitorMaxDeletePerRun || DEFAULT_MAX_DELETE_PER_RUN);
  if (Number.isFinite(value) && value > 0) {
    return Math.min(value, 5_000);
  }
  return DEFAULT_MAX_DELETE_PER_RUN;
};

const walkFiles = async (dir) => {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(absolutePath);
      files.push(...nested);
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
};

const cleanupTempFiles = async () => {
  if (!janitorEnabled()) {
    return { scanned: 0, deleted: 0, skipped: true };
  }
  if (janitorRunning) {
    return { scanned: 0, deleted: 0, skipped: true };
  }

  janitorRunning = true;
  try {
    const maxAgeMs = resolveMaxAgeMs();
    const deleteLimit = resolveMaxDeletePerRun();
    const staleBeforeTs = Date.now() - maxAgeMs;

    const files = await walkFiles(tempRoot);
    let deleted = 0;

    for (const filePath of files) {
      if (deleted >= deleteLimit) break;

      let stat = null;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }

      const modifiedTs = Number(stat.mtimeMs || 0);
      if (modifiedTs >= staleBeforeTs) {
        continue;
      }

      try {
        await fs.promises.unlink(filePath);
        deleted += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn('Temp file cleanup failed for a path', {
            filePath,
            error: error.message,
          });
        }
      }
    }

    return {
      scanned: files.length,
      deleted,
      skipped: false,
    };
  } finally {
    janitorRunning = false;
  }
};

const startTempFileJanitor = () => {
  if (!janitorEnabled() || janitorTimer) {
    return;
  }

  const intervalMs = resolveIntervalMs();
  janitorTimer = setInterval(() => {
    cleanupTempFiles()
      .then((result) => {
        if (result.deleted > 0) {
          logger.info('Temp janitor removed stale files', result);
        }
      })
      .catch((error) => {
        logger.warn('Temp janitor run failed', { error: error.message });
      });
  }, intervalMs);
  janitorTimer.unref?.();
};

const stopTempFileJanitor = () => {
  if (!janitorTimer) return;
  clearInterval(janitorTimer);
  janitorTimer = null;
};

module.exports = {
  startTempFileJanitor,
  stopTempFileJanitor,
  cleanupTempFiles,
};
