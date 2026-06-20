#!/usr/bin/env node
/*
 * READ-ONLY diagnostic for the sensor-snapshot backfill apply-plan mismatch.
 * Performs only SELECT queries (via the same candidate loader the script uses).
 * Writes tmp/backfills/<batchId>/apply-mismatch-diagnostic.json
 * Does NOT write to the database. Does NOT mutate anything.
 */
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const {
  buildBackfillPlan,
  resolveIstDateRange,
  stableStringify,
  outputDirectory,
} = require('./backfill-inspection-sensor-snapshots');

const BATCH_ID = 'sensor-history-20260501-20260620-v1';
const FROM_IST = '2026-05-01';
const TO_IST = '2026-06-20';
const OUTPUT_BASE = 'tmp/backfills';

// Faithful read-only replica of loadCandidateData() from the backfill script.
const loadCandidateData = async ({ dateRange }) => {
  const { sequelize, InspectionMedia } = require('../src/models');
  const inspections = await sequelize.query(
    `
      SELECT
        id, tenant_id, facility_id, toilet_unit_id, captured_at, submitted_at,
        status, processing_status, pipeline_status, avg_before_score, avg_after_score,
        overall_status, sensor_snapshot, suspicious_flag, validation_failed_count,
        rejected_image_count, updated_at
      FROM inspections
      WHERE captured_at >= :startUtc
        AND captured_at < :endExclusiveUtc
      ORDER BY tenant_id ASC, captured_at ASC, id ASC
    `,
    {
      replacements: {
        startUtc: dateRange.startUtc,
        endExclusiveUtc: dateRange.endExclusiveUtc,
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

const main = async () => {
  const outDir = outputDirectory(OUTPUT_BASE, BATCH_ID);
  const summaryPath = path.join(outDir, 'dry-run-summary.json');
  const proposedPath = path.join(outDir, 'proposed-snapshots.json');
  const dryRunSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const dryRunProposed = JSON.parse(fs.readFileSync(proposedPath, 'utf8'));

  const dateRange = resolveIstDateRange({ fromIst: FROM_IST, toIst: TO_IST });
  const data = await loadCandidateData({ dateRange });

  // Regenerate the apply plan exactly like runApply() does:
  // reuse the reviewed dry-run generatedAt, apply mode flags.
  const args = {
    batchId: BATCH_ID,
    allTenants: true,
    tenantId: null,
    apply: true,
    allowStatusFallback: false,
    limit: null,
  };
  const plan = buildBackfillPlan({
    inspections: data.inspections,
    mediaByInspection: data.mediaByInspection,
    args,
    dateRange,
    generatedAt: dryRunSummary.generatedAt,
  });

  const currentProposed = plan.proposed;

  // Build maps keyed by inspectionId.
  const dryById = new Map(dryRunProposed.map((r) => [r.inspectionId, r]));
  const curById = new Map(currentProposed.map((r) => [r.inspectionId, r]));

  const onlyInDry = [...dryById.keys()].filter((id) => !curById.has(id));
  const onlyInCur = [...curById.keys()].filter((id) => !dryById.has(id));

  const mismatches = [];
  let onlyGeneratedAtCount = 0;
  let valueDiffCount = 0;
  let dateTypeDiffCount = 0;

  // Field-level comparison using the SAME stableStringify the guard uses.
  const fieldKeys = new Set();
  for (const id of dryById.keys()) {
    if (!curById.has(id)) continue;
    const a = dryById.get(id);
    const b = curById.get(id);
    if (stableStringify(a) === stableStringify(b)) continue;

    const diffFields = [];
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of allKeys) {
      const sa = stableStringify(a[k]);
      const sb = stableStringify(b[k]);
      if (sa !== sb) {
        diffFields.push({
          field: k,
          dryRunSerialized: sa.length > 120 ? `${sa.slice(0, 120)}...` : sa,
          currentSerialized: sb.length > 120 ? `${sb.slice(0, 120)}...` : sb,
          dryRunRawType: a[k] instanceof Object ? (a[k] instanceof Date ? 'Date' : typeof a[k]) : typeof a[k],
          currentRawType: b[k] instanceof Object ? (b[k] instanceof Date ? 'Date' : typeof b[k]) : typeof b[k],
        });
        fieldKeys.add(k);
      }
    }

    // Compare the actual generated snapshot VALUES ignoring representation,
    // by JSON round-tripping (Date -> ISO string) which is how artifacts persist.
    const snapA = JSON.parse(JSON.stringify(a.generatedSensorSnapshot));
    const snapB = JSON.parse(JSON.stringify(b.generatedSensorSnapshot));
    const snapshotValuesDiffer = stableStringify(snapA) !== stableStringify(snapB);
    if (snapshotValuesDiffer) valueDiffCount += 1;

    // Are all diffs only date-typed top-level fields (string vs Date)?
    const allDiffsAreDateType = diffFields.length > 0 && diffFields.every(
      (d) => d.currentRawType === 'Date' && d.dryRunRawType === 'string'
    );
    if (allDiffsAreDateType && !snapshotValuesDiffer) dateTypeDiffCount += 1;

    const onlyGeneratedAt = diffFields.length === 1 && diffFields[0].field === 'generatedAt';
    if (onlyGeneratedAt) onlyGeneratedAtCount += 1;

    mismatches.push({
      inspectionId: id,
      diffFields,
      snapshotValuesDiffer,
      reason: snapshotValuesDiffer
        ? 'generated_value_change'
        : allDiffsAreDateType
        ? 'date_object_vs_iso_string_serialization'
        : onlyGeneratedAt
        ? 'only_generatedAt'
        : 'other',
    });
  }

  const diagnostic = {
    generatedDiagnosticAt: new Date().toISOString(),
    batchId: BATCH_ID,
    note: 'READ-ONLY diagnostic. No DB writes performed.',
    counts: {
      oldDryRunCandidateCount: dryRunSummary.totalFoundInDateRange,
      currentCandidateCount: data.inspections.length,
      oldEligibleCount: dryRunSummary.eligibleUpdates,
      currentEligibleCount: currentProposed.length,
      candidateCountChanged: dryRunSummary.totalFoundInDateRange !== data.inspections.length,
      eligibleCountChanged: dryRunSummary.eligibleUpdates !== currentProposed.length,
      onlyInDryRunCount: onlyInDry.length,
      onlyInCurrentCount: onlyInCur.length,
      mismatchedRowCount: mismatches.length,
    },
    onlyInDryRunInspectionIds: onlyInDry.slice(0, 20),
    onlyInCurrentInspectionIds: onlyInCur.slice(0, 20),
    first20MismatchedInspectionIds: mismatches.slice(0, 20).map((m) => m.inspectionId),
    mismatchReasonPerInspection: mismatches.slice(0, 20).map((m) => ({
      inspectionId: m.inspectionId,
      reason: m.reason,
      diffFields: m.diffFields.map((d) => d.field),
    })),
    differingFieldNames: [...fieldKeys],
    classification: {
      isOnlyGeneratedAt: mismatches.length > 0 && onlyGeneratedAtCount === mismatches.length,
      isDueToRowOrCandidateChanges:
        dryRunSummary.totalFoundInDateRange !== data.inspections.length ||
        dryRunSummary.eligibleUpdates !== currentProposed.length ||
        onlyInDry.length > 0 ||
        onlyInCur.length > 0,
      isDueToGeneratedValueChanges: valueDiffCount > 0,
      isDueToDateSerialization: dateTypeDiffCount > 0 && valueDiffCount === 0,
      isDueToSortingOrderSerializationOnly:
        valueDiffCount === 0 &&
        onlyInDry.length === 0 &&
        onlyInCur.length === 0 &&
        dryRunSummary.eligibleUpdates === currentProposed.length,
    },
    recommendedFix: null,
  };

  diagnostic.recommendedFix = diagnostic.classification.isDueToGeneratedValueChanges
    ? 'Generated VALUES differ between dry-run and apply. Do NOT force apply. Re-run dry-run and review.'
    : diagnostic.classification.isDueToRowOrCandidateChanges
    ? 'Candidate/eligible set changed since dry-run. Do NOT force apply. Re-run dry-run and review the new result.'
    : diagnostic.classification.isDueToDateSerialization
    ? 'Comparison is comparing JS Date objects (fresh plan from pg) against ISO strings (persisted dry-run JSON). stableStringify serializes Date -> {} but string -> "...". Fix assertPlansMatch to compare a CANONICAL JSON form (JSON.parse(JSON.stringify(rows)) so Dates -> ISO strings, then sort by inspectionId) on BOTH sides. Do not relax safety-relevant field comparison.'
    : 'No deterministic mismatch detected after canonicalization; investigate before applying.';

  fs.writeFileSync(
    path.join(outDir, 'apply-mismatch-diagnostic.json'),
    `${JSON.stringify(diagnostic, null, 2)}\n`
  );
  console.log(JSON.stringify(diagnostic, null, 2));
};

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { sequelize } = require('../src/models');
      await sequelize.close();
    } catch (_) {
      /* no-op */
    }
  });
