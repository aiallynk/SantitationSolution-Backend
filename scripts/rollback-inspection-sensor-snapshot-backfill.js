#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transaction } = require('sequelize');
const { stableStringify } = require('./backfill-inspection-sensor-snapshots');

const CONFIRM_ROLLBACK_TOKEN = 'SENSOR_BACKFILL_ROLLBACK_CONFIRMED';
const CHUNK_SIZE = 50;

const nowIso = () => new Date().toISOString();

const parseArgs = (argv = process.argv.slice(2)) => {
  const args = {
    backupFile: null,
    batchId: null,
    confirmRollback: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backup-file') args.backupFile = argv[++i];
    else if (arg === '--batch-id') args.batchId = argv[++i];
    else if (arg === '--confirm-rollback') args.confirmRollback = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
};

const usage = () => `
Usage:
  node scripts/rollback-inspection-sensor-snapshot-backfill.js --backup-file tmp/backfills/<batch-id>/pre-apply-inspection-backup.json --batch-id <batch-id> --confirm-rollback ${CONFIRM_ROLLBACK_TOKEN}
`;

const ensureArgs = (args) => {
  if (!args.backupFile) throw new Error('--backup-file is required');
  if (!args.batchId) throw new Error('--batch-id is required');
  if (args.confirmRollback !== CONFIRM_ROLLBACK_TOKEN) {
    throw new Error(`--confirm-rollback ${CONFIRM_ROLLBACK_TOKEN} is required`);
  }
};

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const verifyBackupChecksum = (backupFile) => {
  const checksumPath = backupFile.replace(/\.json$/i, '.sha256');
  if (!fs.existsSync(checksumPath)) throw new Error('Pre-apply backup checksum file is missing');
  const text = fs.readFileSync(checksumPath, 'utf8').trim();
  const match = text.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
  if (!match) throw new Error('Pre-apply backup checksum file is invalid');
  const expected = match[1].toLowerCase();
  const expectedName = match[2].trim();
  if (expectedName !== path.basename(backupFile)) {
    throw new Error('Pre-apply backup checksum file references a different file');
  }
  const actual = sha256File(backupFile);
  if (actual !== expected) throw new Error('Pre-apply backup checksum mismatch');
  return { checksumPath, checksum: actual };
};

const loadBackup = ({ backupFile, batchId }) => {
  if (!fs.existsSync(backupFile)) throw new Error('Pre-apply backup file is missing');
  const checksum = verifyBackupChecksum(backupFile);
  const payload = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  if (payload.batchId !== batchId) throw new Error('Pre-apply backup batchId does not match --batch-id');
  if (!Array.isArray(payload.rows)) throw new Error('Pre-apply backup rows are missing');
  return { payload, checksum };
};

const loadModels = () => require('../src/models');

const isMatchingSyntheticSnapshot = (current, expectedSnapshot, batchId) => {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return { ok: false, reason: 'current_snapshot_missing_or_not_object' };
  }
  if (current.isSynthetic !== true || current.isBackfilled !== true) {
    return { ok: false, reason: 'current_snapshot_not_synthetic_backfill' };
  }
  if (current.backfillBatchId !== batchId) {
    return { ok: false, reason: 'current_snapshot_batch_mismatch' };
  }
  if (stableStringify(current) !== stableStringify(expectedSnapshot)) {
    return { ok: false, reason: 'current_snapshot_changed_after_backfill' };
  }
  return { ok: true, reason: null };
};

const chunk = (rows, size) => {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
};

const writeCsv = (filePath, rows, headers) => {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => escape(row[header])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
};

const runRollback = async ({ backupFile, batchId }) => {
  const { payload, checksum } = loadBackup({ backupFile, batchId });
  const { sequelize, Inspection } = loadModels();
  const rows = payload.rows;
  const restored = [];
  const skipped = [];
  const startedAt = nowIso();

  for (const group of chunk(rows, CHUNK_SIZE)) {
    await sequelize.transaction(async (transaction) => {
      for (const row of group) {
        const inspection = await Inspection.findByPk(row.inspectionId, {
          attributes: ['id', 'sensor_snapshot'],
          transaction,
          lock: Transaction.LOCK.UPDATE,
        });
        if (!inspection) {
          skipped.push({ inspectionId: row.inspectionId, reason: 'inspection_not_found' });
          continue;
        }
        const guard = isMatchingSyntheticSnapshot(
          inspection.sensor_snapshot,
          row.generatedSensorSnapshot,
          batchId
        );
        if (!guard.ok) {
          skipped.push({ inspectionId: row.inspectionId, reason: guard.reason });
          continue;
        }
        await Inspection.update(
          { sensor_snapshot: row.originalSensorSnapshot ?? null },
          { where: { id: row.inspectionId }, transaction }
        );
        restored.push({ inspectionId: row.inspectionId, tenantId: row.tenantId });
      }
    });
  }

  const outputDir = path.dirname(path.resolve(backupFile));
  const summary = {
    batchId,
    startedAt,
    completedAt: nowIso(),
    backupFile: path.resolve(backupFile),
    checksumPath: checksum.checksumPath,
    rowsInBackup: rows.length,
    rowsRestored: restored.length,
    rowsSkipped: skipped.length,
  };
  fs.writeFileSync(path.join(outputDir, 'rollback-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outputDir, 'rollback-log.txt'),
    [
      `[${nowIso()}] Rollback completed.`,
      `Rows in backup: ${rows.length}`,
      `Rows restored: ${restored.length}`,
      `Rows skipped: ${skipped.length}`,
    ].join('\n') + '\n'
  );
  writeCsv(path.join(outputDir, 'rollback-skipped.csv'), skipped, ['inspectionId', 'reason']);

  return { summary, restored, skipped };
};

const main = async () => {
  const args = parseArgs();
  if (args.help) {
    console.log(usage().trim());
    return;
  }
  ensureArgs(args);
  const result = await runRollback({ backupFile: path.resolve(args.backupFile), batchId: args.batchId });
  console.log(JSON.stringify({ ok: true, ...result.summary }, null, 2));
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        const { sequelize } = loadModels();
        await sequelize.close();
      } catch (_) {
        // No DB was opened.
      }
    });
}

module.exports = {
  CONFIRM_ROLLBACK_TOKEN,
  isMatchingSyntheticSnapshot,
  loadBackup,
  parseArgs,
  runRollback,
  verifyBackupChecksum,
};
