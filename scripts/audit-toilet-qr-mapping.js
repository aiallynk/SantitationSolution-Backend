const { sequelize, ToiletUnit, Facility } = require('../src/models');

const args = new Set(process.argv.slice(2));
const shouldRepairNormalized = args.has('--repair-normalized');
const failOnIssues = args.has('--fail-on-issues');

const normalizeQr = (value) => String(value || '').trim().toUpperCase();
const looksLikeUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );

const run = async () => {
  await sequelize.authenticate();

  const rows = await ToiletUnit.findAll({
    attributes: ['id', 'facility_id', 'code', 'qr_code', 'status'],
    include: [
      {
        model: Facility,
        attributes: ['id', 'tenant_id', 'code', 'status'],
        required: false,
      },
    ],
    order: [['created_at', 'ASC']],
  });

  const duplicatesByNormalizedQr = new Map();
  const unmappedToilets = [];
  const normalizationMismatches = [];
  const inactiveMappedToilets = [];
  const printedVsStoredMismatches = [];

  const normalizedByUnitId = new Map();
  for (const row of rows) {
    const rawQr = String(row.qr_code || '');
    const normalizedQr = normalizeQr(rawQr);
    const unitId = String(row.id || '');
    const unitCode = String(row.code || '').trim();
    const facility = row.Facility || null;

    normalizedByUnitId.set(unitId, normalizedQr);

    if (!normalizedQr) {
      unmappedToilets.push({
        toiletUnitId: unitId,
        toiletCode: unitCode || null,
        facilityId: row.facility_id || null,
        facilityCode: facility?.code || null,
      });
      continue;
    }

    if (!duplicatesByNormalizedQr.has(normalizedQr)) {
      duplicatesByNormalizedQr.set(normalizedQr, []);
    }
    duplicatesByNormalizedQr.get(normalizedQr).push({
      toiletUnitId: unitId,
      toiletCode: unitCode || null,
      rawQrValue: rawQr,
      facilityId: row.facility_id || null,
      facilityCode: facility?.code || null,
    });

    if (rawQr !== normalizedQr) {
      normalizationMismatches.push({
        toiletUnitId: unitId,
        rawQrValue: rawQr,
        normalizedQrValue: normalizedQr,
      });
    }

    const unitInactive = String(row.status || '').toLowerCase() === 'out_of_service';
    const facilityInactive =
      facility &&
      String(facility.status || '').trim().toLowerCase() !== 'active';
    if (unitInactive || facilityInactive) {
      inactiveMappedToilets.push({
        toiletUnitId: unitId,
        qrValue: rawQr,
        unitStatus: row.status,
        facilityStatus: facility?.status || null,
      });
    }

    const normalizedCode = normalizeQr(unitCode);
    const isCodeAligned =
      normalizedCode &&
      (normalizedQr === normalizedCode || normalizedQr.includes(normalizedCode));
    if (!isCodeAligned && !looksLikeUuid(normalizedQr)) {
      printedVsStoredMismatches.push({
        toiletUnitId: unitId,
        toiletCode: unitCode || null,
        qrValue: rawQr,
      });
    }
  }

  const duplicateMappings = Array.from(duplicatesByNormalizedQr.entries())
    .filter(([, mappings]) => mappings.length > 1)
    .map(([normalizedQr, mappings]) => ({
      normalizedQr,
      count: mappings.length,
      mappings,
    }));

  const safeRepairCandidates = normalizationMismatches.filter((item) => {
    const normalizedQr = normalizeQr(item.normalizedQrValue);
    const mappings = duplicatesByNormalizedQr.get(normalizedQr) || [];
    return mappings.length === 1;
  });

  const skippedRepairCandidates = normalizationMismatches.filter((item) => {
    const normalizedQr = normalizeQr(item.normalizedQrValue);
    const mappings = duplicatesByNormalizedQr.get(normalizedQr) || [];
    return mappings.length > 1;
  });

  const repaired = [];
  if (shouldRepairNormalized && safeRepairCandidates.length > 0) {
    for (const item of safeRepairCandidates) {
      await ToiletUnit.update(
        { qr_code: item.normalizedQrValue, updated_at: new Date() },
        { where: { id: item.toiletUnitId } }
      );
      repaired.push({
        toiletUnitId: item.toiletUnitId,
        normalizedQrValue: item.normalizedQrValue,
      });
    }
  }

  const summary = {
    totalToiletUnits: rows.length,
    unmappedCount: unmappedToilets.length,
    duplicateMappingCount: duplicateMappings.length,
    normalizationMismatchCount: normalizationMismatches.length,
    inactiveMappedCount: inactiveMappedToilets.length,
    printedVsStoredMismatchCount: printedVsStoredMismatches.length,
    repairedCount: repaired.length,
    skippedRepairCount: skippedRepairCandidates.length,
  };

  const report = {
    summary,
    unmappedToilets,
    duplicateMappings,
    normalizationMismatches,
    inactiveMappedToilets,
    printedVsStoredMismatches,
    repaired,
    skippedRepairCandidates,
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  const hasBlockingIssues =
    unmappedToilets.length > 0 ||
    duplicateMappings.length > 0 ||
    normalizationMismatches.length > 0;
  if (failOnIssues && hasBlockingIssues) {
    process.exitCode = 1;
  }
};

run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('QR mapping audit failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
