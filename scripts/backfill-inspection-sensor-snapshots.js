#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const {
  generateSyntheticSensorSnapshot,
  toNumberOrNull,
} = require('../src/modules/sensors/syntheticSensorBackfill.generator');
const { verifyBackupDirectory } = require('./backup-database');

const CONFIRM_APPLY_TOKEN = 'SENSOR_BACKFILL_APPLY_CONFIRMED';
const DEFAULT_OUTPUT_DIR = 'tmp/backfills';
const CHUNK_SIZE = 50;
const NO_TOUCH_TABLES = [
  'sensor_readings',
  'sensor_devices',
  'inspection_media',
  'alerts',
  'ai_analysis_results',
  'ai_processing_jobs',
  'toilet_units',
  'toilet_score_daily',
  'dashboard_aggregates',
  'platform_users',
  'tenants',
  'roles',
  'permissions',
  'role_permissions',
  'user_roles',
];

const nowIso = () => new Date().toISOString();

const parseArgs = (argv = process.argv.slice(2)) => {
  const args = {
    dryRun: false,
    apply: false,
    tenantId: null,
    allTenants: false,
    fromIst: null,
    toIst: null,
    batchId: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    limit: null,
    allowStatusFallback: false,
    backupDir: null,
    confirmApply: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--tenant-id') args.tenantId = argv[++i];
    else if (arg === '--all-tenants') args.allTenants = true;
    else if (arg === '--from-ist') args.fromIst = argv[++i];
    else if (arg === '--to-ist') args.toIst = argv[++i];
    else if (arg === '--batch-id') args.batchId = argv[++i];
    else if (arg === '--output-dir') args.outputDir = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--allow-status-fallback') args.allowStatusFallback = true;
    else if (arg === '--backup-dir') args.backupDir = argv[++i];
    else if (arg === '--confirm-apply') args.confirmApply = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.dryRun && !args.apply) args.dryRun = true;
  if (args.dryRun && args.apply) throw new Error('Use either --dry-run or --apply, not both');
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return args;
};

const usage = () => `
Usage:
  node scripts/backfill-inspection-sensor-snapshots.js --dry-run --all-tenants --from-ist 2026-05-01 --to-ist 2026-06-20 --batch-id sensor-history-20260501-20260620-v1
  node scripts/backfill-inspection-sensor-snapshots.js --apply --all-tenants --from-ist 2026-05-01 --to-ist 2026-06-20 --batch-id sensor-history-20260501-20260620-v1 --backup-dir backups/db/<backup-id> --confirm-apply ${CONFIRM_APPLY_TOKEN}
`;

const parseIstDate = (value) => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid IST date: ${value}. Expected YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return { year, month, day, text };
};

const istMidnightToUtc = ({ year, month, day }) =>
  new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - 330 * 60_000);

const addUtcDays = ({ year, month, day }, days) => {
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

const resolveIstDateRange = ({ fromIst, toIst }) => {
  const from = parseIstDate(fromIst);
  const to = parseIstDate(toIst);
  const startUtc = istMidnightToUtc(from);
  const endExclusiveUtc = istMidnightToUtc(addUtcDays(to, 1));
  if (endExclusiveUtc.getTime() <= startUtc.getTime()) {
    throw new Error('--to-ist must be the same as or after --from-ist');
  }
  return {
    timezone: 'Asia/Kolkata',
    fromIst: from.text,
    toIst: to.text,
    startUtc,
    endExclusiveUtc,
    startUtcIso: startUtc.toISOString(),
    endExclusiveUtcIso: endExclusiveUtc.toISOString(),
  };
};

const ensureRequiredArgs = (args) => {
  if (!args.batchId) throw new Error('--batch-id is required');
  if (!args.fromIst) throw new Error('--from-ist is required');
  if (!args.toIst) throw new Error('--to-ist is required');
  if (args.tenantId && args.allTenants) throw new Error('Use either --tenant-id or --all-tenants, not both');
  if (!args.tenantId && !args.allTenants) throw new Error('Supply --tenant-id or --all-tenants');
  if (args.apply) {
    if (!args.backupDir) throw new Error('--backup-dir is required for --apply');
    if (args.confirmApply !== CONFIRM_APPLY_TOKEN) {
      throw new Error(`--confirm-apply ${CONFIRM_APPLY_TOKEN} is required for --apply`);
    }
  }
};

const loadModels = () => require('../src/models');

const outputDirectory = (baseDir, batchId) => path.resolve(baseDir || DEFAULT_OUTPUT_DIR, batchId);

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const csvEscape = (value) => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const writeCsv = (filePath, rows, headers) => {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
};

const sha256Text = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const writeChecksumForFile = (filePath) => {
  const checksumPath = filePath.replace(/\.json$/i, '.sha256');
  fs.writeFileSync(checksumPath, `${sha256File(filePath)}  ${path.basename(filePath)}\n`);
  return checksumPath;
};

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
};

const isPresentSnapshot = (value) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '' && value.trim() !== 'null';
  if (typeof value === 'object') return true;
  return Boolean(value);
};

const average = (values) => {
  const nums = values.map(toNumberOrNull).filter((value) => value !== null);
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
};

const scoreBand = (score) => {
  const value = Number(score);
  if (value >= 85) return 'excellent';
  if (value >= 70) return 'good';
  if (value >= 50) return 'average';
  if (value >= 30) return 'poor';
  return 'critical';
};

const mediaBuckets = (mediaRows = []) => {
  const buckets = { after: [], before: [], all: [] };
  for (const row of mediaRows) {
    const score = toNumberOrNull(row.overall_score);
    if (score === null) continue;
    const stage = String(row.capture_stage || '').toLowerCase();
    buckets.all.push(score);
    if (stage.includes('after')) buckets.after.push(score);
    else if (stage.includes('before')) buckets.before.push(score);
  }
  return buckets;
};

const chooseInspectionScore = ({ inspection, mediaRows = [], allowStatusFallback = false }) => {
  const after = toNumberOrNull(inspection.avg_after_score);
  if (after !== null) return { score: after, sourceField: 'avg_after_score' };
  const before = toNumberOrNull(inspection.avg_before_score);
  if (before !== null) return { score: before, sourceField: 'avg_before_score' };

  const buckets = mediaBuckets(mediaRows);
  const mediaAfter = average(buckets.after);
  if (mediaAfter !== null) return { score: mediaAfter, sourceField: 'inspection_media.after.overall_score' };
  const mediaBefore = average(buckets.before);
  if (mediaBefore !== null) return { score: mediaBefore, sourceField: 'inspection_media.before.overall_score' };
  const mediaAny = average(buckets.all);
  if (mediaAny !== null) return { score: mediaAny, sourceField: 'inspection_media.overall_score' };

  if (allowStatusFallback) {
    const status = String(inspection.overall_status || '').toLowerCase();
    const fallback = { clean: 82, moderate: 65, poor: 45, critical: 25 }[status];
    if (fallback !== undefined) return { score: fallback, sourceField: 'overall_status' };
  }
  return null;
};

const isDraftOrIncomplete = (inspection) => {
  const status = String(inspection.status || '').trim().toLowerCase();
  const processing = String(inspection.processing_status || '').trim().toLowerCase();
  const pipeline = String(inspection.pipeline_status || '').trim().toLowerCase();
  if (!inspection.submitted_at) return true;
  if (status === 'draft' || processing === 'draft' || pipeline === 'draft') return true;
  if (['queued', 'processing'].includes(processing)) return true;
  return false;
};

const isSuspiciousOrFailed = (inspection) => {
  const status = String(inspection.status || '').trim().toLowerCase();
  const processing = String(inspection.processing_status || '').trim().toLowerCase();
  const pipeline = String(inspection.pipeline_status || '').trim().toLowerCase();
  if (inspection.suspicious_flag === true || String(inspection.suspicious_flag) === 'true') return true;
  return [status, processing, pipeline].some((value) => value.includes('failed'));
};

const classifyInspection = ({ inspection, mediaRows = [], allowStatusFallback = false }) => {
  if (isPresentSnapshot(inspection.sensor_snapshot)) return { eligible: false, reason: 'already_has_sensor_snapshot' };
  if (isSuspiciousOrFailed(inspection)) return { eligible: false, reason: 'suspicious_or_failed' };
  if (isDraftOrIncomplete(inspection)) return { eligible: false, reason: 'draft_or_incomplete' };
  const selected = chooseInspectionScore({ inspection, mediaRows, allowStatusFallback });
  if (!selected) return { eligible: false, reason: 'missing_score' };
  return { eligible: true, reason: 'eligible', selected };
};

const loadCandidateData = async ({ dateRange, tenantId = null }) => {
  const { sequelize, InspectionMedia } = loadModels();
  const tenantClause = tenantId ? 'AND tenant_id = :tenantId' : '';
  const inspections = await sequelize.query(
    `
      SELECT
        id,
        tenant_id,
        facility_id,
        toilet_unit_id,
        captured_at,
        submitted_at,
        status,
        processing_status,
        pipeline_status,
        avg_before_score,
        avg_after_score,
        overall_status,
        sensor_snapshot,
        suspicious_flag,
        validation_failed_count,
        rejected_image_count,
        updated_at
      FROM inspections
      WHERE captured_at >= :startUtc
        AND captured_at < :endExclusiveUtc
        ${tenantClause}
      ORDER BY tenant_id ASC, captured_at ASC, id ASC
    `,
    {
      replacements: {
        startUtc: dateRange.startUtc,
        endExclusiveUtc: dateRange.endExclusiveUtc,
        tenantId,
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  const inspectionIds = inspections.map((row) => row.id);
  const mediaByInspection = new Map();
  if (inspectionIds.length > 0) {
    const mediaRows = await InspectionMedia.findAll({
      attributes: ['inspection_id', 'capture_stage', 'overall_score'],
      where: {
        inspection_id: { [Op.in]: inspectionIds },
        overall_score: { [Op.not]: null },
        scoring_rejected: { [Op.not]: true },
      },
      raw: true,
    });
    for (const media of mediaRows) {
      const list = mediaByInspection.get(media.inspection_id) || [];
      list.push(media);
      mediaByInspection.set(media.inspection_id, list);
    }
  }
  return { inspections, mediaByInspection };
};

const summarizeValues = (proposedRows) => {
  const metrics = ['score', 'temperature', 'humidity', 'mq135', 'mq137', 'batteryLevel', 'rssi'];
  const result = {};
  for (const metric of metrics) {
    const values = proposedRows
      .map((row) => toNumberOrNull(row.generatedSensorSnapshot?.[metric]))
      .filter((value) => value !== null);
    if (values.length === 0) {
      result[metric] = { count: 0, min: null, max: null, avg: null };
      continue;
    }
    result[metric] = {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
    };
  }
  return result;
};

const increment = (target, key) => {
  target[key] = Number(target[key] || 0) + 1;
};

const buildBackfillPlan = ({
  inspections,
  mediaByInspection,
  args,
  dateRange,
  generatedAt,
}) => {
  const skipped = [];
  const proposed = [];
  const skippedCounts = {};
  const scoreBandDistribution = {};

  for (const inspection of inspections) {
    const mediaRows = mediaByInspection.get(inspection.id) || [];
    const classification = classifyInspection({
      inspection,
      mediaRows,
      allowStatusFallback: args.allowStatusFallback,
    });
    if (!classification.eligible) {
      increment(skippedCounts, classification.reason);
      skipped.push({
        inspectionId: inspection.id,
        tenantId: inspection.tenant_id,
        facilityId: inspection.facility_id,
        toiletUnitId: inspection.toilet_unit_id,
        capturedAt: inspection.captured_at,
        reason: classification.reason,
      });
      continue;
    }

    const selected = classification.selected;
    const band = scoreBand(selected.score);
    increment(scoreBandDistribution, band);
    const generatedSensorSnapshot = generateSyntheticSensorSnapshot({
      inspectionId: inspection.id,
      tenantId: inspection.tenant_id,
      toiletUnitId: inspection.toilet_unit_id,
      capturedAt: inspection.captured_at,
      submittedAt: inspection.submitted_at,
      selectedScore: selected.score,
      scoreSourceField: selected.sourceField,
      batchId: args.batchId,
      generatedAt,
      avgBeforeScore: inspection.avg_before_score,
      avgAfterScore: inspection.avg_after_score,
    });
    proposed.push({
      inspectionId: inspection.id,
      tenantId: inspection.tenant_id,
      facilityId: inspection.facility_id,
      toiletUnitId: inspection.toilet_unit_id,
      capturedAt: inspection.captured_at,
      submittedAt: inspection.submitted_at,
      status: inspection.status,
      processingStatus: inspection.processing_status,
      avgBeforeScore: toNumberOrNull(inspection.avg_before_score),
      avgAfterScore: toNumberOrNull(inspection.avg_after_score),
      overallStatus: inspection.overall_status,
      originalUpdatedAt: inspection.updated_at,
      scoreSourceField: selected.sourceField,
      scoreUsed: Math.round(Number(selected.score) * 100) / 100,
      scoreBand: band,
      generatedSensorSnapshot,
    });
  }

  const limited = args.limit ? proposed.slice(0, args.limit) : proposed;
  const limitSkipped = proposed.length - limited.length;
  if (limitSkipped > 0) skippedCounts.excluded_by_limit = limitSkipped;

  const warnings = [];
  if (!args.allowStatusFallback) {
    warnings.push('Status fallback is disabled; rows without numeric scores are skipped.');
  }
  if (args.allTenants) {
    warnings.push('All-tenant scope was explicitly selected.');
  }

  return {
    proposed: limited,
    skipped,
    summary: {
      batchId: args.batchId,
      generatedAt,
      mode: args.apply ? 'apply-plan' : 'dry-run',
      dateRangeIst: { from: dateRange.fromIst, to: dateRange.toIst, timezone: dateRange.timezone },
      resolvedUtcRange: {
        startInclusive: dateRange.startUtcIso,
        endExclusive: dateRange.endExclusiveUtcIso,
      },
      tenantScope: args.allTenants ? { allTenants: true } : { tenantId: args.tenantId },
      totalFoundInDateRange: inspections.length,
      eligibleBeforeLimit: proposed.length,
      eligibleUpdates: limited.length,
      skippedCounts,
      scoreBandDistribution,
      generatedValueDistribution: summarizeValues(limited),
      sampleProposedSnapshots: limited.slice(0, 5).map((row) => ({
        inspectionId: row.inspectionId,
        tenantId: row.tenantId,
        scoreUsed: row.scoreUsed,
        scoreSourceField: row.scoreSourceField,
        snapshot: row.generatedSensorSnapshot,
      })),
      warnings,
      noDbWrites: !args.apply,
    },
  };
};

const proposedCsvRows = (rows) => rows.map((row) => ({
  inspectionId: row.inspectionId,
  tenantId: row.tenantId,
  facilityId: row.facilityId,
  toiletUnitId: row.toiletUnitId,
  capturedAt: row.capturedAt,
  scoreSourceField: row.scoreSourceField,
  scoreUsed: row.scoreUsed,
  scoreBand: row.scoreBand,
  temperature: row.generatedSensorSnapshot.temperature,
  humidity: row.generatedSensorSnapshot.humidity,
  mq135: row.generatedSensorSnapshot.mq135,
  mq137: row.generatedSensorSnapshot.mq137,
  batteryLevel: row.generatedSensorSnapshot.batteryLevel,
  rssi: row.generatedSensorSnapshot.rssi,
  snapshot: row.generatedSensorSnapshot,
}));

const writeDryRunArtifacts = ({ outDir, plan }) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'dry-run-summary.json'), plan.summary);
  writeJson(path.join(outDir, 'proposed-snapshots.json'), plan.proposed);
  writeJson(path.join(outDir, 'value-distribution.json'), plan.summary.generatedValueDistribution);
  writeCsv(path.join(outDir, 'proposed-snapshots.csv'), proposedCsvRows(plan.proposed), [
    'inspectionId',
    'tenantId',
    'facilityId',
    'toiletUnitId',
    'capturedAt',
    'scoreSourceField',
    'scoreUsed',
    'scoreBand',
    'temperature',
    'humidity',
    'mq135',
    'mq137',
    'batteryLevel',
    'rssi',
    'snapshot',
  ]);
  writeCsv(path.join(outDir, 'skipped-inspections.csv'), plan.skipped, [
    'inspectionId',
    'tenantId',
    'facilityId',
    'toiletUnitId',
    'capturedAt',
    'reason',
  ]);
  fs.writeFileSync(
    path.join(outDir, 'dry-run-log.txt'),
    [
      `[${nowIso()}] Dry-run completed.`,
      `No database writes were performed.`,
      `Eligible updates: ${plan.summary.eligibleUpdates}`,
      `Skipped counts: ${JSON.stringify(plan.summary.skippedCounts)}`,
    ].join('\n') + '\n'
  );
};

const readDryRunArtifacts = (outDir, batchId) => {
  const summaryPath = path.join(outDir, 'dry-run-summary.json');
  const proposedPath = path.join(outDir, 'proposed-snapshots.json');
  if (!fs.existsSync(summaryPath)) throw new Error('dry-run-summary.json is required before apply');
  if (!fs.existsSync(proposedPath)) throw new Error('proposed-snapshots.json is required before apply');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const proposed = JSON.parse(fs.readFileSync(proposedPath, 'utf8'));
  if (summary.batchId !== batchId) throw new Error('Dry-run summary batchId does not match --batch-id');
  return { summary, proposed };
};

// Canonicalize proposed rows so the apply-time comparison matches the reviewed
// dry-run artifact regardless of representation differences that are NOT
// semantic changes:
//   - The freshly regenerated apply plan carries JS Date objects for date fields
//     (the pg driver returns timestamptz columns as Date), while the reviewed
//     dry-run JSON holds ISO strings. JSON.stringify normalizes Date -> the same
//     ISO string that was persisted, so both sides become structurally identical.
//   - Sorting by inspectionId makes the comparison order-insensitive.
// Every safety-relevant field is preserved (nothing is stripped) so the guard
// still fails on real row, candidate, or generated-value changes.
const canonicalizeProposed = (proposedRows) =>
  proposedRows
    .map((row) => JSON.parse(JSON.stringify(row)))
    .sort((a, b) => String(a.inspectionId).localeCompare(String(b.inspectionId)));

const assertPlansMatch = (dryRunProposed, currentProposed) => {
  const left = stableStringify(canonicalizeProposed(dryRunProposed));
  const right = stableStringify(canonicalizeProposed(currentProposed));
  if (left !== right) {
    throw new Error('Current apply plan does not match reviewed dry-run output. Re-run dry-run and review again.');
  }
};

const getNoTouchFingerprints = async (sequelize) => {
  const output = {};
  for (const table of NO_TOUCH_TABLES) {
    const [row] = await sequelize.query(
      `
        SELECT
          COUNT(*)::bigint AS row_count,
          MAX(updated_at) AS max_updated_at
        FROM ${table}
      `,
      { type: sequelize.QueryTypes.SELECT }
    );
    output[table] = {
      rowCount: Number(row.row_count || 0),
      maxUpdatedAt: row.max_updated_at ? new Date(row.max_updated_at).toISOString() : null,
    };
  }
  return output;
};

const exportPreApplyBackup = ({ outDir, proposedRows, batchId }) => {
  const payload = {
    batchId,
    createdAt: nowIso(),
    rowCount: proposedRows.length,
    rows: proposedRows.map((row) => ({
      inspectionId: row.inspectionId,
      tenantId: row.tenantId,
      facilityId: row.facilityId,
      toiletUnitId: row.toiletUnitId,
      capturedAt: row.capturedAt,
      submittedAt: row.submittedAt,
      status: row.status,
      processingStatus: row.processingStatus,
      avgBeforeScore: row.avgBeforeScore,
      avgAfterScore: row.avgAfterScore,
      overallStatus: row.overallStatus,
      originalSensorSnapshot: null,
      originalUpdatedAt: row.originalUpdatedAt,
      generatedSensorSnapshot: row.generatedSensorSnapshot,
    })),
  };
  const filePath = path.join(outDir, 'pre-apply-inspection-backup.json');
  writeJson(filePath, payload);
  const checksumPath = writeChecksumForFile(filePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) {
    throw new Error('Pre-apply inspection backup could not be written');
  }
  if (!fs.existsSync(checksumPath) || fs.statSync(checksumPath).size <= 0) {
    throw new Error('Pre-apply inspection backup checksum could not be written');
  }
  return { filePath, checksumPath };
};

const chunk = (rows, size) => {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
};

const applySnapshots = async ({ proposedRows }) => {
  const { sequelize, Inspection } = loadModels();
  const chunks = chunk(proposedRows, CHUNK_SIZE);
  const updated = [];
  const skipped = [];
  const errors = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const rows = chunks[index];
    try {
      await sequelize.transaction(async (transaction) => {
        for (const row of rows) {
          const [count] = await Inspection.update(
            { sensor_snapshot: row.generatedSensorSnapshot },
            {
              where: { id: row.inspectionId, sensor_snapshot: null },
              transaction,
            }
          );
          if (count !== 1) {
            throw new Error(`Guarded update skipped inspection ${row.inspectionId}`);
          }
          updated.push({
            inspectionId: row.inspectionId,
            tenantId: row.tenantId,
            scoreUsed: row.scoreUsed,
            scoreBand: row.scoreBand,
          });
        }
      });
    } catch (error) {
      errors.push({ chunkIndex: index, error: error.message });
      skipped.push(...rows.map((row) => ({ inspectionId: row.inspectionId, reason: 'chunk_failed_or_guard_skipped' })));
      error.applyResult = {
        rowsPlanned: proposedRows.length,
        rowsUpdated: updated.length,
        rowsSkippedDuringGuardedUpdate: skipped.length,
        updated,
        skipped,
        errors,
        chunkStats: {
          chunkSize: CHUNK_SIZE,
          chunkCount: chunks.length,
          failedChunkIndex: index,
        },
      };
      throw error;
    }
  }

  return {
    rowsPlanned: proposedRows.length,
    rowsUpdated: updated.length,
    rowsSkippedDuringGuardedUpdate: skipped.length,
    updated,
    skipped,
    errors,
    chunkStats: {
      chunkSize: CHUNK_SIZE,
      chunkCount: chunks.length,
    },
  };
};

const postApplyVerification = async ({ batchId, dateRange, beforeFingerprints }) => {
  const { sequelize } = loadModels();
  const countByTenant = await sequelize.query(
    `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::bigint AS row_count
      FROM inspections
      WHERE sensor_snapshot->>'backfillBatchId' = :batchId
      GROUP BY tenant_id
      ORDER BY tenant_id
    `,
    { replacements: { batchId }, type: sequelize.QueryTypes.SELECT }
  );
  const [metrics] = await sequelize.query(
    `
      SELECT
        COUNT(*)::bigint AS row_count,
        MIN((sensor_snapshot->>'temperature')::numeric) AS min_temperature,
        MAX((sensor_snapshot->>'temperature')::numeric) AS max_temperature,
        MIN((sensor_snapshot->>'humidity')::numeric) AS min_humidity,
        MAX((sensor_snapshot->>'humidity')::numeric) AS max_humidity,
        MIN((sensor_snapshot->>'mq135')::numeric) AS min_mq135,
        MAX((sensor_snapshot->>'mq135')::numeric) AS max_mq135,
        MIN((sensor_snapshot->>'mq137')::numeric) AS min_mq137,
        MAX((sensor_snapshot->>'mq137')::numeric) AS max_mq137
      FROM inspections
      WHERE sensor_snapshot->>'backfillBatchId' = :batchId
    `,
    { replacements: { batchId }, type: sequelize.QueryTypes.SELECT }
  );
  const [outsideRange] = await sequelize.query(
    `
      SELECT COUNT(*)::bigint AS row_count
      FROM inspections
      WHERE sensor_snapshot->>'backfillBatchId' = :batchId
        AND (captured_at < :startUtc OR captured_at >= :endExclusiveUtc)
    `,
    {
      replacements: {
        batchId,
        startUtc: dateRange.startUtc,
        endExclusiveUtc: dateRange.endExclusiveUtc,
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );
  const afterFingerprints = await getNoTouchFingerprints(sequelize);
  const noTouchChanged = stableStringify(beforeFingerprints) !== stableStringify(afterFingerprints);
  return {
    verifiedAt: nowIso(),
    status: Number(outsideRange.row_count || 0) === 0 && !noTouchChanged ? 'passed' : 'failed',
    batchId,
    countByTenant: countByTenant.map((row) => ({ tenantId: row.tenant_id, rowCount: Number(row.row_count || 0) })),
    generatedMetricBounds: metrics,
    rowsOutsideDateRange: Number(outsideRange.row_count || 0),
    noTouchTables: {
      before: beforeFingerprints,
      after: afterFingerprints,
      changed: noTouchChanged,
    },
    assertions: {
      allNoTouchFingerprintsUnchanged: !noTouchChanged,
      noRowsOutsideDateRange: Number(outsideRange.row_count || 0) === 0,
      noSensorReadingsInserted: beforeFingerprints.sensor_readings.rowCount === afterFingerprints.sensor_readings.rowCount,
      noSensorDevicesChanged: stableStringify(beforeFingerprints.sensor_devices) === stableStringify(afterFingerprints.sensor_devices),
      noInspectionMediaChanged: stableStringify(beforeFingerprints.inspection_media) === stableStringify(afterFingerprints.inspection_media),
      noAlertsCreated: beforeFingerprints.alerts.rowCount === afterFingerprints.alerts.rowCount,
      noAiAnalysisChanged: stableStringify(beforeFingerprints.ai_analysis_results) === stableStringify(afterFingerprints.ai_analysis_results),
      noAiJobsChanged: stableStringify(beforeFingerprints.ai_processing_jobs) === stableStringify(afterFingerprints.ai_processing_jobs),
      noToiletUnitsChanged: stableStringify(beforeFingerprints.toilet_units) === stableStringify(afterFingerprints.toilet_units),
      noToiletScoreDailyChanged: stableStringify(beforeFingerprints.toilet_score_daily) === stableStringify(afterFingerprints.toilet_score_daily),
      noDashboardAggregatesChanged: stableStringify(beforeFingerprints.dashboard_aggregates) === stableStringify(afterFingerprints.dashboard_aggregates),
      noUsersChanged: stableStringify(beforeFingerprints.platform_users) === stableStringify(afterFingerprints.platform_users),
      noTenantsChanged: stableStringify(beforeFingerprints.tenants) === stableStringify(afterFingerprints.tenants),
      noRbacChanged:
        stableStringify(beforeFingerprints.roles) === stableStringify(afterFingerprints.roles) &&
        stableStringify(beforeFingerprints.permissions) === stableStringify(afterFingerprints.permissions) &&
        stableStringify(beforeFingerprints.role_permissions) === stableStringify(afterFingerprints.role_permissions) &&
        stableStringify(beforeFingerprints.user_roles) === stableStringify(afterFingerprints.user_roles),
    },
  };
};

const writeApplyArtifacts = ({ outDir, applyResult, verification, backupInfo, startedAt }) => {
  const summary = {
    batchId: backupInfo.batchId,
    startedAt,
    completedAt: nowIso(),
    rowsPlanned: applyResult.rowsPlanned,
    rowsUpdated: applyResult.rowsUpdated,
    rowsSkippedDuringGuardedUpdate: applyResult.rowsSkippedDuringGuardedUpdate,
    errors: applyResult.errors,
    transaction: applyResult.chunkStats,
    backupPath: backupInfo.preApplyBackupPath,
    backupChecksumPath: backupInfo.preApplyChecksumPath,
    databaseBackupDir: backupInfo.databaseBackupDir,
    postApplyVerificationResult: verification.status,
  };
  writeJson(path.join(outDir, 'apply-summary.json'), summary);
  writeJson(path.join(outDir, 'post-apply-verification.json'), verification);
  writeCsv(path.join(outDir, 'updated-inspections.csv'), applyResult.updated, [
    'inspectionId',
    'tenantId',
    'scoreUsed',
    'scoreBand',
  ]);
  if (applyResult.errors.length > 0) {
    writeCsv(path.join(outDir, 'apply-errors.csv'), applyResult.errors, ['chunkIndex', 'error']);
  }
  fs.writeFileSync(
    path.join(outDir, 'apply-log.txt'),
    [
      `[${nowIso()}] Apply completed.`,
      `Rows planned: ${applyResult.rowsPlanned}`,
      `Rows updated: ${applyResult.rowsUpdated}`,
      `Verification: ${verification.status}`,
    ].join('\n') + '\n'
  );
};

const runDryRun = async ({ args, dateRange }) => {
  const outDir = outputDirectory(args.outputDir, args.batchId);
  const generatedAt = nowIso();
  const data = await loadCandidateData({ dateRange, tenantId: args.tenantId });
  const plan = buildBackfillPlan({
    inspections: data.inspections,
    mediaByInspection: data.mediaByInspection,
    args,
    dateRange,
    generatedAt,
  });
  writeDryRunArtifacts({ outDir, plan });
  return { outDir, plan };
};

const runApply = async ({ args, dateRange }) => {
  const outDir = outputDirectory(args.outputDir, args.batchId);
  ensureDir(outDir);
  const verifiedBackup = await verifyBackupDirectory(args.backupDir);
  const dryRun = readDryRunArtifacts(outDir, args.batchId);
  const data = await loadCandidateData({ dateRange, tenantId: args.tenantId });
  const plan = buildBackfillPlan({
    inspections: data.inspections,
    mediaByInspection: data.mediaByInspection,
    args,
    dateRange,
    generatedAt: dryRun.summary.generatedAt,
  });
  assertPlansMatch(dryRun.proposed, plan.proposed);
  const { sequelize } = loadModels();
  const beforeFingerprints = await getNoTouchFingerprints(sequelize);
  const preApply = exportPreApplyBackup({ outDir, proposedRows: plan.proposed, batchId: args.batchId });
  const applyStartedAt = nowIso();
  let applyResult;
  let verification;
  try {
    applyResult = await applySnapshots({ proposedRows: plan.proposed });
    verification = await postApplyVerification({
      batchId: args.batchId,
      dateRange,
      beforeFingerprints,
    });
  } catch (error) {
    applyResult = error.applyResult || {
      rowsPlanned: plan.proposed.length,
      rowsUpdated: 0,
      rowsSkippedDuringGuardedUpdate: 0,
      updated: [],
      skipped: [],
      errors: [{ chunkIndex: null, error: error.message }],
      chunkStats: { chunkSize: CHUNK_SIZE, chunkCount: Math.ceil(plan.proposed.length / CHUNK_SIZE) },
    };
    verification = {
      verifiedAt: nowIso(),
      status: 'failed',
      batchId: args.batchId,
      error: error.message,
      noTouchTables: { before: beforeFingerprints, after: null, changed: null },
    };
    writeApplyArtifacts({
      outDir,
      applyResult,
      verification,
      backupInfo: {
        batchId: args.batchId,
        preApplyBackupPath: preApply.filePath,
        preApplyChecksumPath: preApply.checksumPath,
        databaseBackupDir: verifiedBackup.backupDir,
      },
      startedAt: applyStartedAt,
    });
    throw error;
  }
  writeApplyArtifacts({
    outDir,
    applyResult,
    verification,
    backupInfo: {
      batchId: args.batchId,
      preApplyBackupPath: preApply.filePath,
      preApplyChecksumPath: preApply.checksumPath,
      databaseBackupDir: verifiedBackup.backupDir,
    },
    startedAt: applyStartedAt,
  });
  if (verification.status !== 'passed') {
    throw new Error('Post-apply verification failed');
  }
  return { outDir, applyResult, verification };
};

const main = async () => {
  const args = parseArgs();
  if (args.help) {
    console.log(usage().trim());
    return;
  }
  ensureRequiredArgs(args);
  const dateRange = resolveIstDateRange({ fromIst: args.fromIst, toIst: args.toIst });
  const result = args.apply ? await runApply({ args, dateRange }) : await runDryRun({ args, dateRange });
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: args.apply ? 'apply' : 'dry-run',
        batchId: args.batchId,
        outputDir: result.outDir,
        defaultModeIsDryRun: !args.apply,
        onlyUpdates: args.apply ? 'inspections.sensor_snapshot' : null,
      },
      null,
      2
    )
  );
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
  CONFIRM_APPLY_TOKEN,
  assertPlansMatch,
  buildBackfillPlan,
  canonicalizeProposed,
  chooseInspectionScore,
  classifyInspection,
  isDraftOrIncomplete,
  isSuspiciousOrFailed,
  loadCandidateData,
  outputDirectory,
  parseArgs,
  readDryRunArtifacts,
  resolveIstDateRange,
  stableStringify,
};
