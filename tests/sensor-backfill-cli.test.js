const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  assertPlansMatch,
  buildBackfillPlan,
  canonicalizeProposed,
  chooseInspectionScore,
  classifyInspection,
  parseArgs,
  readDryRunArtifacts,
  resolveIstDateRange,
} = require('../scripts/backfill-inspection-sensor-snapshots');
const {
  isMatchingSyntheticSnapshot,
  loadBackup,
} = require('../scripts/rollback-inspection-sensor-snapshot-backfill');
const { verifyBackupDirectory } = require('../scripts/backup-database');

// Mimics how the pg driver returns inspection rows: timestamptz columns come
// back as JS Date objects (not ISO strings). The reviewed dry-run artifact,
// by contrast, is JSON on disk where those same fields are ISO strings.
const buildApplyPlan = ({ generatedAt = '2026-06-20T08:22:38.734Z', inspections } = {}) => {
  const dateRange = resolveIstDateRange({ fromIst: '2026-05-01', toIst: '2026-06-20' });
  const args = {
    batchId: 'sensor-history-20260501-20260620-v1',
    allTenants: true,
    tenantId: null,
    apply: true,
    allowStatusFallback: false,
    limit: null,
  };
  const rows = inspections || [
    {
      id: 'aaaa1111-1111-4111-8111-111111111111',
      tenant_id: 'bbbb2222-2222-4222-8222-222222222222',
      facility_id: 'cccc3333-3333-4333-8333-333333333333',
      toilet_unit_id: 'dddd4444-4444-4444-8444-444444444444',
      captured_at: new Date('2026-05-10T04:30:00.000Z'),
      submitted_at: new Date('2026-05-10T04:35:00.000Z'),
      status: 'FULLY_SCORED',
      processing_status: 'completed',
      pipeline_status: 'completed',
      avg_before_score: '40.00',
      avg_after_score: '85.00',
      overall_status: 'clean',
      sensor_snapshot: null,
      suspicious_flag: false,
      updated_at: new Date('2026-05-10T05:00:00.000Z'),
    },
  ];
  return buildBackfillPlan({
    inspections: rows,
    mediaByInspection: new Map(),
    args,
    dateRange,
    generatedAt,
  });
};

// The persisted dry-run proposed array is JSON on disk: Date fields are strings.
const asPersistedDryRun = (proposedRows) => JSON.parse(JSON.stringify(proposedRows));

const baseInspection = {
  id: 'inspection-1',
  tenant_id: 'tenant-1',
  facility_id: 'facility-1',
  toilet_unit_id: 'toilet-1',
  captured_at: '2026-05-10T04:30:00.000Z',
  submitted_at: '2026-05-10T04:35:00.000Z',
  status: 'FULLY_SCORED',
  processing_status: 'completed',
  pipeline_status: 'completed',
  avg_before_score: null,
  avg_after_score: null,
  overall_status: null,
  sensor_snapshot: null,
  suspicious_flag: false,
};

test('parseArgs defaults to dry-run', () => {
  const args = parseArgs([
    '--all-tenants',
    '--from-ist',
    '2026-05-01',
    '--to-ist',
    '2026-06-20',
    '--batch-id',
    'sensor-history-20260501-20260620-v1',
  ]);
  assert.equal(args.dryRun, true);
  assert.equal(args.apply, false);
});

test('score selection prefers after score, then before score, then media', () => {
  assert.deepEqual(
    chooseInspectionScore({
      inspection: { ...baseInspection, avg_after_score: '88.5', avg_before_score: '44.0' },
    }),
    { score: 88.5, sourceField: 'avg_after_score' }
  );
  assert.deepEqual(
    chooseInspectionScore({
      inspection: { ...baseInspection, avg_before_score: '44.0' },
    }),
    { score: 44, sourceField: 'avg_before_score' }
  );
  assert.deepEqual(
    chooseInspectionScore({
      inspection: baseInspection,
      mediaRows: [
        { capture_stage: 'before', overall_score: '20' },
        { capture_stage: 'after', overall_score: '80' },
        { capture_stage: 'after_cleaning', overall_score: '90' },
      ],
    }),
    { score: 85, sourceField: 'inspection_media.after.overall_score' }
  );
});

test('status fallback is disabled unless explicitly allowed', () => {
  assert.equal(
    chooseInspectionScore({
      inspection: { ...baseInspection, overall_status: 'clean' },
      allowStatusFallback: false,
    }),
    null
  );
  assert.deepEqual(
    chooseInspectionScore({
      inspection: { ...baseInspection, overall_status: 'clean' },
      allowStatusFallback: true,
    }),
    { score: 82, sourceField: 'overall_status' }
  );
});

test('classification skips protected rows before generating snapshots', () => {
  assert.equal(
    classifyInspection({
      inspection: { ...baseInspection, sensor_snapshot: { score: 5 } },
    }).reason,
    'already_has_sensor_snapshot'
  );
  assert.equal(
    classifyInspection({
      inspection: { ...baseInspection, status: 'DRAFT' },
    }).reason,
    'draft_or_incomplete'
  );
  assert.equal(
    classifyInspection({
      inspection: { ...baseInspection, suspicious_flag: true },
    }).reason,
    'suspicious_or_failed'
  );
  assert.equal(
    classifyInspection({
      inspection: baseInspection,
    }).reason,
    'missing_score'
  );
});

test('backfill plan uses media capture time when inspection captured_at is date-only', () => {
  const dateRange = resolveIstDateRange({ fromIst: '2026-05-01', toIst: '2026-06-20' });
  const plan = buildBackfillPlan({
    inspections: [
      {
        ...baseInspection,
        captured_at: '2026-05-10T00:00:00.000Z',
        submitted_at: '2026-05-10T12:30:00.000Z',
        avg_after_score: '82.00',
      },
    ],
    mediaByInspection: new Map([
      [
        baseInspection.id,
        [
          {
            inspection_id: baseInspection.id,
            capture_stage: 'after',
            captured_at: '2026-05-10T09:42:00.000Z',
            overall_score: '82',
          },
        ],
      ],
    ]),
    args: {
      batchId: 'sensor-history-20260501-20260620-v1',
      allTenants: true,
      tenantId: null,
      apply: false,
      allowStatusFallback: false,
      includeSuspicious: false,
      includeDrafts: false,
      limit: null,
    },
    dateRange,
    generatedAt: '2026-06-20T08:22:38.734Z',
  });

  assert.equal(plan.proposed[0].inspectionTime.toISOString(), '2026-05-10T09:42:00.000Z');
  assert.equal(plan.proposed[0].inspectionTimeSource, 'inspection_media.captured_at');
  assert.equal(plan.proposed[0].generatedSensorSnapshot.readingTime, '2026-05-10T09:42:00.000Z');
});

test('rollback guard only accepts matching synthetic snapshots from the same batch', () => {
  const snapshot = {
    isSynthetic: true,
    isBackfilled: true,
    backfillBatchId: 'batch-1',
    score: 7,
  };
  assert.equal(isMatchingSyntheticSnapshot(snapshot, snapshot, 'batch-1').ok, true);
  assert.equal(isMatchingSyntheticSnapshot({ ...snapshot, score: 8 }, snapshot, 'batch-1').reason, 'current_snapshot_changed_after_backfill');
  assert.equal(isMatchingSyntheticSnapshot({ ...snapshot, backfillBatchId: 'batch-2' }, snapshot, 'batch-1').reason, 'current_snapshot_batch_mismatch');
  assert.equal(isMatchingSyntheticSnapshot({ ...snapshot, isSynthetic: false }, snapshot, 'batch-1').reason, 'current_snapshot_not_synthetic_backfill');
});

test('rollback backup loader refuses missing checksum and wrong batch id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-backfill-'));
  const backupFile = path.join(tmp, 'pre-apply-inspection-backup.json');
  fs.writeFileSync(backupFile, JSON.stringify({ batchId: 'batch-1', rows: [] }));

  assert.throws(() => loadBackup({ backupFile, batchId: 'batch-1' }), /checksum file is missing/);

  const checksum = crypto.createHash('sha256').update(fs.readFileSync(backupFile)).digest('hex');
  fs.writeFileSync(path.join(tmp, 'pre-apply-inspection-backup.sha256'), `${checksum}  pre-apply-inspection-backup.json\n`);

  assert.throws(() => loadBackup({ backupFile, batchId: 'batch-2' }), /batchId does not match/);
  assert.equal(loadBackup({ backupFile, batchId: 'batch-1' }).payload.batchId, 'batch-1');
});

// --- Regression coverage for the apply-plan mismatch (Date vs ISO string) ---

test('dry-run then apply planning matches when DB data is unchanged (Date vs ISO string)', () => {
  const applyPlan = buildApplyPlan();
  const persistedDryRun = asPersistedDryRun(applyPlan.proposed);

  // Sanity: the persisted dry-run truly has string dates while the fresh apply
  // plan has Date objects — i.e. we are exercising the exact production scenario.
  assert.equal(typeof persistedDryRun[0].capturedAt, 'string');
  assert.ok(applyPlan.proposed[0].capturedAt instanceof Date);

  // The guard must NOT trip on representation alone.
  assert.doesNotThrow(() => assertPlansMatch(persistedDryRun, applyPlan.proposed));

  // Canonical forms are byte-identical.
  const { stableStringify } = require('../scripts/backfill-inspection-sensor-snapshots');
  assert.equal(
    stableStringify(canonicalizeProposed(persistedDryRun)),
    stableStringify(canonicalizeProposed(applyPlan.proposed))
  );
});

test('generatedAt does not cause apply mismatch when the reviewed plan timestamp is reused', () => {
  const reviewedGeneratedAt = '2026-06-20T08:22:38.734Z';
  const dryRun = asPersistedDryRun(buildApplyPlan({ generatedAt: reviewedGeneratedAt }).proposed);

  // Apply re-plans with the SAME reviewed generatedAt -> matches.
  const applySame = buildApplyPlan({ generatedAt: reviewedGeneratedAt });
  assert.doesNotThrow(() => assertPlansMatch(dryRun, applySame.proposed));

  // generatedAt is still part of the compared snapshot: a DIFFERENT timestamp
  // must trip the guard (we did not blanket-ignore metadata).
  const applyDifferent = buildApplyPlan({ generatedAt: '2026-06-20T10:00:00.000Z' });
  assert.throws(
    () => assertPlansMatch(dryRun, applyDifferent.proposed),
    /does not match reviewed dry-run output/
  );
});

test('apply still fails when the candidate set changed after dry-run', () => {
  const dryRun = asPersistedDryRun(buildApplyPlan().proposed);

  // A second eligible inspection appears in the DB after the dry-run.
  const extra = {
    id: 'eeee5555-5555-4555-8555-555555555555',
    tenant_id: 'bbbb2222-2222-4222-8222-222222222222',
    facility_id: 'cccc3333-3333-4333-8333-333333333333',
    toilet_unit_id: 'dddd4444-4444-4444-8444-444444444444',
    captured_at: new Date('2026-05-11T04:30:00.000Z'),
    submitted_at: new Date('2026-05-11T04:35:00.000Z'),
    status: 'FULLY_SCORED',
    processing_status: 'completed',
    pipeline_status: 'completed',
    avg_before_score: '30.00',
    avg_after_score: '60.00',
    overall_status: 'moderate',
    sensor_snapshot: null,
    suspicious_flag: false,
    updated_at: new Date('2026-05-11T05:00:00.000Z'),
  };
  const base = buildApplyPlan().proposed[0];
  const rebuilt = buildApplyPlan({
    inspections: [
      {
        id: base.inspectionId,
        tenant_id: base.tenantId,
        facility_id: base.facilityId,
        toilet_unit_id: base.toiletUnitId,
        captured_at: new Date(base.capturedAt),
        submitted_at: new Date(base.submittedAt),
        status: base.status,
        processing_status: base.processingStatus,
        pipeline_status: 'completed',
        avg_before_score: base.avgBeforeScore,
        avg_after_score: base.avgAfterScore,
        overall_status: base.overallStatus,
        sensor_snapshot: null,
        suspicious_flag: false,
        updated_at: new Date(base.originalUpdatedAt),
      },
      extra,
    ],
  });
  assert.throws(() => assertPlansMatch(dryRun, rebuilt.proposed), /does not match reviewed dry-run output/);
});

test('apply still fails when a generated snapshot value differs', () => {
  const dryRun = asPersistedDryRun(buildApplyPlan().proposed);
  const tampered = asPersistedDryRun(buildApplyPlan().proposed);
  tampered[0].generatedSensorSnapshot.temperature += 0.1; // a single drifted value

  assert.throws(() => assertPlansMatch(dryRun, tampered), /does not match reviewed dry-run output/);
});

test('apply still fails when reviewed dry-run artifacts are missing or stale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-backfill-artifacts-'));

  // Missing artifacts entirely.
  assert.throws(
    () => readDryRunArtifacts(tmp, 'sensor-history-20260501-20260620-v1'),
    /dry-run-summary\.json is required/
  );

  // Stale / wrong-batch summary present.
  fs.writeFileSync(path.join(tmp, 'dry-run-summary.json'), JSON.stringify({ batchId: 'some-other-batch' }));
  fs.writeFileSync(path.join(tmp, 'proposed-snapshots.json'), JSON.stringify([]));
  assert.throws(
    () => readDryRunArtifacts(tmp, 'sensor-history-20260501-20260620-v1'),
    /batchId does not match/
  );
});

test('apply still fails when backup verification fails (missing backup dir)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-backfill-nobackup-'));
  const missingDir = path.join(tmp, 'does-not-exist');
  await assert.rejects(
    verifyBackupDirectory(missingDir, {
      commandRunner: async () => ({ ok: true, stdout: 'TABLE DATA', stderr: '', exitCode: 0 }),
    })
  );
});
