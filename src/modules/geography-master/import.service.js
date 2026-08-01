'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  Geography,
  GlobalGeographyImportBatch,
  GlobalGeographyImportStaging,
  GlobalGeographySource,
  GlobalGeographyAlias,
} = require('../../models');
const { normalizeCoordinates, normalizeName, shouldPreferSource } = require('./normalization');

const DEFAULT_BATCH_SIZE = 2000;
const LEVEL_ORDER = ['country', 'state', 'district', 'city'];
const NON_SEMANTIC_PAYLOAD_FIELDS = new Set(['id', 'tenant_id', 'import_batch_id', 'updated_at']);

const comparableValue = (value) => {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const hasGeographyChanges = (existing, payload) => Object.entries(payload).some(([key, value]) => (
  !NON_SEMANTIC_PAYLOAD_FIELDS.has(key)
  && comparableValue(existing?.get?.(key) ?? existing?.[key]) !== comparableValue(value)
));

const sourceAttribution = (source) => {
  if (source === 'GEONAMES') {
    return {
      source_licence: 'CC BY 4.0',
      source_attribution: 'GeoNames',
      source_reference: 'https://www.geonames.org/',
    };
  }
  if (source === 'LGD' || String(source || '').startsWith('LGD')) {
    return {
      source_licence: 'Government Open Data License - India',
      source_attribution: 'Local Government Directory, Ministry of Panchayati Raj, Government of India',
      source_reference: 'https://lgdirectory.gov.in/',
    };
  }
  return {};
};

const isLgdSource = (source) => String(source || '').toUpperCase() === 'LGD';

const officialNameVariants = (name, level) => {
  const normalized = normalizeName(name);
  const variants = new Set([normalized]);
  if (!normalized) return [];
  if (level === 'state') {
    variants.add(normalizeName(`State of ${name}`));
    variants.add(normalizeName(`Union Territory of ${name}`));
    variants.add(normalizeName(`${name} State`));
    if (normalized.startsWith('the ')) variants.add(normalized.replace(/^the\s+/, ''));
    else variants.add(normalizeName(`The ${name}`));
  }
  if (level === 'district') {
    variants.add(normalizeName(`${name} District`));
    variants.add(normalizeName(`${name} Division`));
  }
  return [...variants];
};

const checksumForFile = async (stream) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
};

const createImportBatch = async ({ source, sourceVersion, sourceFile, checksum, inputScope = 'all' }) => {
  const normalizedSource = String(source || '').trim().toUpperCase();
  if (!normalizedSource) throw new Error('Import source is required');
  if (checksum) {
    const existing = await GlobalGeographyImportBatch.findOne({ where: { source: normalizedSource, checksum, input_scope: inputScope } });
    if (existing) return { batch: existing, reused: true };
  }
  const batch = await GlobalGeographyImportBatch.create({
    source: normalizedSource,
    input_scope: inputScope,
    source_version: sourceVersion || null,
    source_file: sourceFile || null,
    checksum: checksum || null,
    status: 'staging',
    started_at: new Date(),
  });
  return { batch, reused: false };
};

const validateStagingRecord = (record) => {
  if (!record.externalCode) return 'externalCode is required';
  if (!record.name) return 'name is required';
  if (!LEVEL_ORDER.includes(record.normalizedLevel)) return 'normalizedLevel is invalid';
  const coordinates = normalizeCoordinates(record.latitude, record.longitude);
  return coordinates.error;
};

const stageRecords = async ({ batchId, source, records, batchSize = DEFAULT_BATCH_SIZE }) => {
  const batch = await GlobalGeographyImportBatch.findByPk(batchId);
  if (!batch) throw new Error('Import batch not found');
  const normalizedSource = String(source || batch.source).toUpperCase();
  const buffer = [];
  let total = 0;
  let rejected = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    await GlobalGeographyImportStaging.bulkCreate(buffer.splice(0), {
      conflictAttributes: ['import_batch_id', 'source', 'external_code'],
      updateOnDuplicate: [
        'parent_external_code', 'raw_name', 'normalized_name', 'raw_level', 'normalized_level',
        'country_iso2', 'country_iso3', 'admin1_code', 'admin2_code', 'admin3_code',
        'admin4_code', 'latitude', 'longitude', 'raw_payload', 'validation_status',
        'validation_error', 'processed_at', 'updated_at',
      ],
    });
  };

  for await (const record of records) {
    total += 1;
    const validationError = validateStagingRecord(record);
    if (validationError) rejected += 1;
    const coordinates = normalizeCoordinates(record.latitude, record.longitude);
    buffer.push({
      import_batch_id: batch.id,
      source: String(record.source || normalizedSource).toUpperCase(),
      external_code: String(record.externalCode || '').trim(),
      parent_external_code: record.parentExternalCode ? String(record.parentExternalCode).trim() : null,
      raw_name: record.name || null,
      normalized_name: normalizeName(record.name),
      raw_level: record.rawLevel || null,
      normalized_level: record.normalizedLevel || null,
      country_iso2: record.countryIso2 ? String(record.countryIso2).toUpperCase() : null,
      country_iso3: record.countryIso3 ? String(record.countryIso3).toUpperCase() : null,
      admin1_code: record.admin1Code || null,
      admin2_code: record.admin2Code || null,
      admin3_code: record.admin3Code || null,
      admin4_code: record.admin4Code || null,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      raw_payload: { ...(record.rawPayload || {}), administrativeType: record.administrativeType || null },
      validation_status: validationError ? 'rejected' : 'valid',
      validation_error: validationError,
      processed_at: null,
      updated_at: new Date(),
    });
    if (buffer.length >= batchSize) await flush();
  }
  await flush();
  await batch.update({
    status: 'staged',
    total_records: total,
    failed_records: rejected,
    checkpoint: { stagedRecords: total },
    updated_at: new Date(),
  });
  return { batchId: batch.id, total, rejected };
};

const sourceMapForCodes = async (source, codes, transaction) => {
  if (codes.length === 0) return new Map();
  const rows = await GlobalGeographySource.findAll({
    where: { source, external_code: { [Op.in]: [...new Set(codes)] } },
    transaction,
  });
  return new Map(rows.map((row) => [String(row.external_code), row]));
};

const resolveParentId = async ({ row, sourceMap, parentMap, transaction }) => {
  if (row.normalized_level === 'country') return null;
  if (isLgdSource(row.source) && row.normalized_level === 'state') {
    const india = await Geography.findOne({
      where: {
        tenant_id: null,
        level: 'country',
        is_active: true,
        [Op.or]: [{ country_iso2: 'IN' }, { country_code: 'IN' }, { normalized_name: 'india' }],
      },
      transaction,
    });
    return india?.id || null;
  }
  return parentMap.get(String(row.parent_external_code || ''))?.global_geography_id || null;
};

const payloadForStagedRow = ({ row, id, parentId, existing, batchId }) => {
  const raw = row.raw_payload || {};
  const sourcePreferred = !existing || shouldPreferSource(existing.preferred_source, row.source);
  const useSourceName = sourcePreferred && row.source !== 'GEOBOUNDARIES';
  const name = useSourceName ? row.raw_name : existing?.name || row.raw_name;
  const coordinatesAvailable = row.latitude !== null && row.longitude !== null;
  return {
    id,
    tenant_id: null,
    parent_id: parentId,
    level: row.normalized_level,
    code: existing?.code || `${row.source}-${row.external_code}`.slice(0, 120),
    name,
    ascii_name: raw.asciiName || existing?.ascii_name || null,
    local_name: raw.localName || existing?.local_name || null,
    normalized_name: normalizeName(name),
    alternate_names: Array.isArray(raw.alternateNames) ? raw.alternateNames.slice(0, 500) : existing?.alternate_names || [],
    external_source: existing?.external_source || row.source,
    external_code: existing?.external_code || row.external_code,
    country_code: row.country_iso2 || existing?.country_code || null,
    country_iso2: row.country_iso2 || existing?.country_iso2 || null,
    country_iso3: row.country_iso3 || existing?.country_iso3 || null,
    admin1_code: row.admin1_code || existing?.admin1_code || null,
    admin2_code: row.admin2_code || existing?.admin2_code || null,
    admin3_code: row.admin3_code || existing?.admin3_code || null,
    admin4_code: row.admin4_code || existing?.admin4_code || null,
    administrative_type: raw.administrativeType || existing?.administrative_type || null,
    source_administrative_level: row.raw_level || existing?.source_administrative_level || null,
    latitude: coordinatesAvailable ? row.latitude : existing?.latitude || null,
    longitude: coordinatesAvailable ? row.longitude : existing?.longitude || null,
    centroid_latitude: coordinatesAvailable ? row.latitude : existing?.centroid_latitude || null,
    centroid_longitude: coordinatesAvailable ? row.longitude : existing?.centroid_longitude || null,
    population: raw.population || existing?.population || null,
    timezone: raw.timezone || existing?.timezone || null,
    preferred_source: sourcePreferred ? row.source : existing?.preferred_source || null,
    preferred_external_code: sourcePreferred ? row.external_code : existing?.preferred_external_code || null,
    source_modified_at: raw.sourceModifiedAt || existing?.source_modified_at || null,
    quality_status: parentId || row.normalized_level === 'country' ? 'imported' : 'incomplete',
    import_batch_id: batchId,
    is_active: raw.isActive !== false,
    is_official_source: true,
    is_platform_managed: true,
    is_verified_local_government: isLgdSource(row.source),
    location_status: coordinatesAvailable || existing?.geojson ? 'mapped' : 'unmapped',
    updated_at: new Date(),
  };
};

const findLgdCanonicalMatch = async ({ row, parentId, transaction }) => {
  const baseWhere = {
    tenant_id: null,
    level: row.normalized_level,
    parent_id: parentId,
    is_active: true,
    [Op.or]: [{ country_iso2: 'IN' }, { country_code: 'IN' }],
  };
  const nameVariants = officialNameVariants(row.raw_name, row.normalized_level);
  const byName = await Geography.findAll({
    where: { ...baseWhere, normalized_name: { [Op.in]: nameVariants } },
    transaction,
  });
  if (byName.length > 0) return { candidates: byName, method: 'parent_level_name_variant' };

  const aliases = await GlobalGeographyAlias.findAll({
    where: { normalized_name: row.normalized_name },
    attributes: ['global_geography_id'],
    transaction,
    raw: true,
  });
  const aliasIds = [...new Set(aliases.map((alias) => alias.global_geography_id).filter(Boolean))];
  if (aliasIds.length === 0) return { candidates: [], method: 'none' };
  const byAlias = await Geography.findAll({
    where: { ...baseWhere, id: { [Op.in]: aliasIds } },
    transaction,
  });
  return { candidates: byAlias, method: 'parent_level_alias' };
};

const importLevelPage = async ({ batch, rows, summary }) => {
  await sequelize.transaction(async (transaction) => {
    const source = batch.source;
    const codes = rows.map((row) => row.external_code);
    const parentCodes = rows.map((row) => row.parent_external_code).filter(Boolean);
    const sourceMap = await sourceMapForCodes(source, codes, transaction);
    const parentMap = await sourceMapForCodes(source, parentCodes, transaction);
    const existingIds = [...new Set([...sourceMap.values()].map((row) => row.global_geography_id))];
    const existingRows = existingIds.length > 0
      ? await Geography.findAll({ where: { id: { [Op.in]: existingIds } }, transaction })
      : [];
    const existingById = new Map(existingRows.map((row) => [String(row.id), row]));
    const geographyPayloads = [];
    const sourcePayloads = [];
    const aliasPayloads = [];
    const processedIds = [];

    for (const row of rows) {
      const sourceReference = sourceMap.get(String(row.external_code));
      let existing = sourceReference ? existingById.get(String(sourceReference.global_geography_id)) : null;
      const parentId = await resolveParentId({ row, sourceMap, parentMap, transaction });
      if (row.normalized_level !== 'country' && !parentId) {
        summary.skipped += 1;
        summary.orphaned += 1;
        await row.update({ validation_status: 'orphaned', validation_error: 'Parent could not be resolved', processed_at: new Date() }, { transaction });
        continue;
      }
      if (!existing && isLgdSource(row.source)) {
        const { candidates, method } = await findLgdCanonicalMatch({ row, parentId, transaction });
        if (candidates.length > 1) {
          summary.skipped += 1;
          await row.update({ validation_status: 'ambiguous', validation_error: `Multiple canonical LGD match candidates via ${method}`, processed_at: new Date() }, { transaction });
          continue;
        }
        existing = candidates[0] || null;
      }
      const geographyId = existing?.id || crypto.randomUUID();
      const payload = payloadForStagedRow({ row, id: geographyId, parentId, existing, batchId: batch.id });
      if (existing && existing.name !== payload.name) {
        aliasPayloads.push({
          global_geography_id: geographyId,
          name: existing.name,
          normalized_name: normalizeName(existing.name),
          source: existing.preferred_source || source,
          is_historic: true,
          updated_at: new Date(),
        });
      }
      geographyPayloads.push(payload);
      sourcePayloads.push({
        id: sourceReference?.id || crypto.randomUUID(),
        global_geography_id: geographyId,
        source,
        external_code: row.external_code,
        source_name: row.raw_name,
        source_level: row.raw_level,
        source_parent_code: row.parent_external_code,
        source_latitude: row.latitude,
        source_longitude: row.longitude,
        source_payload: row.raw_payload,
        ...sourceAttribution(source),
        source_modified_at: row.raw_payload?.sourceModifiedAt || null,
        is_preferred: payload.preferred_source === source,
        updated_at: new Date(),
      });
      processedIds.push(row.id);
      if (existing && hasGeographyChanges(existing, payload)) summary.updated += 1;
      else if (existing) summary.unchanged += 1;
      else summary.inserted += 1;
    }

    if (geographyPayloads.length > 0) {
      await Geography.bulkCreate(geographyPayloads, {
        updateOnDuplicate: Object.keys(geographyPayloads[0]).filter((key) => !['id', 'tenant_id', 'created_at'].includes(key)),
        transaction,
      });
      await GlobalGeographySource.bulkCreate(sourcePayloads, {
        updateOnDuplicate: [
          'global_geography_id', 'source_name', 'source_level', 'source_parent_code',
          'source_latitude', 'source_longitude', 'source_payload', 'source_modified_at',
          'source_licence', 'source_attribution', 'source_reference', 'is_preferred', 'updated_at',
        ],
        transaction,
      });
      if (aliasPayloads.length > 0) {
        await GlobalGeographyAlias.bulkCreate(aliasPayloads, { ignoreDuplicates: true, transaction });
      }
    }
    if (processedIds.length > 0) {
      await GlobalGeographyImportStaging.update(
        { validation_status: 'processed', processed_at: new Date(), updated_at: new Date() },
        { where: { id: { [Op.in]: processedIds } }, transaction }
      );
    }
  });
};

const importStagedBatch = async ({ batchId, batchSize = DEFAULT_BATCH_SIZE, retireMissing = false }) => {
  const batch = await GlobalGeographyImportBatch.findByPk(batchId);
  if (!batch) throw new Error('Import batch not found');
  if (batch.status === 'completed') return { batchId: batch.id, reused: true, summary: batch.error_summary?.summary || null };
  const summary = { total: Number(batch.total_records || 0), inserted: 0, updated: 0, unchanged: 0, skipped: 0, orphaned: 0, retired: 0 };
  await batch.update({ status: 'importing', updated_at: new Date() });
  try {
    for (const level of LEVEL_ORDER) {
      let lastId = null;
      while (true) {
        const rows = await GlobalGeographyImportStaging.findAll({
          where: {
            import_batch_id: batch.id,
            normalized_level: level,
            validation_status: 'valid',
            ...(lastId ? { id: { [Op.gt]: lastId } } : {}),
          },
          order: [['id', 'ASC']],
          limit: batchSize,
        });
        if (rows.length === 0) break;
        await importLevelPage({ batch, rows, summary });
        lastId = rows.at(-1).id;
        await batch.update({ checkpoint: { level, lastId }, updated_at: new Date() });
      }
    }
    if (retireMissing) {
      const stagedCodes = await GlobalGeographyImportStaging.findAll({
        where: { import_batch_id: batch.id, validation_status: 'processed' },
        attributes: ['external_code', 'normalized_level', 'country_iso2'],
        raw: true,
      });
      if (stagedCodes.length > 0) {
        const importedLevels = [...new Set(stagedCodes.map((row) => row.normalized_level).filter(Boolean))];
        const importedCountries = [...new Set(stagedCodes.map((row) => row.country_iso2).filter(Boolean))];
        const references = await GlobalGeographySource.findAll({
          where: { source: batch.source, external_code: { [Op.notIn]: stagedCodes.map((row) => row.external_code) } },
          attributes: ['global_geography_id'],
          raw: true,
        });
        const [retired] = await Geography.update(
          { is_active: false, updated_at: new Date() },
          {
            where: {
              id: { [Op.in]: references.map((row) => row.global_geography_id) },
              tenant_id: null,
              is_active: true,
              preferred_source: batch.source,
              level: { [Op.in]: importedLevels },
              ...(importedCountries.length > 0 ? { country_iso2: { [Op.in]: importedCountries } } : {}),
            },
          }
        );
        summary.retired = Number(retired || 0);
      }
    }
    await batch.update({
      status: 'completed',
      completed_at: new Date(),
      inserted_records: summary.inserted,
      updated_records: summary.updated,
      unchanged_records: summary.unchanged,
      skipped_records: summary.skipped,
      error_summary: { summary },
      updated_at: new Date(),
    });
    return { batchId: batch.id, reused: false, summary };
  } catch (error) {
    await batch.update({ status: 'failed', completed_at: new Date(), error_summary: { message: error.message, summary }, updated_at: new Date() });
    throw error;
  }
};

const markSourceRecordsInactive = async ({ source, externalCodes, batchId = null }) => {
  const references = await GlobalGeographySource.findAll({
    where: { source: String(source).toUpperCase(), external_code: { [Op.in]: externalCodes } },
    attributes: ['global_geography_id'],
    raw: true,
  });
  const ids = [...new Set(references.map((row) => row.global_geography_id))];
  if (ids.length === 0) return 0;
  const [count] = await Geography.update(
    { is_active: false, import_batch_id: batchId, updated_at: new Date() },
    { where: { id: { [Op.in]: ids }, tenant_id: null } }
  );
  return Number(count || 0);
};

module.exports = {
  DEFAULT_BATCH_SIZE,
  LEVEL_ORDER,
  checksumForFile,
  createImportBatch,
  stageRecords,
  importStagedBatch,
  markSourceRecordsInactive,
};
