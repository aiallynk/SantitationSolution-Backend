'use strict';

require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');
const {
  sequelize,
  GlobalGeographyAlias,
  GlobalGeographyImportBatch,
  GlobalGeographyImportStaging,
  Geography,
  GlobalGeographySource,
} = require('../src/models');
const {
  loadGeoNamesCodeMaps,
  streamGeoNamesCountryInfoRecords,
  streamGeoNamesRecords,
  streamGeoNamesDeletes,
  streamGeoNamesAlternateNames,
} = require('../src/modules/geography-master/geonames.adapter');
const { streamLgdRecords } = require('../src/modules/geography-master/lgd.adapter');
const { createImportBatch, stageRecords, importStagedBatch, markSourceRecordsInactive } = require('../src/modules/geography-master/import.service');
const { importGeoBoundariesFeatureCollection } = require('../src/modules/geography-master/boundary.service');
const { importGeoNamesAliases } = require('../src/modules/geography-master/alias.service');

const BASE_URL = 'https://download.geonames.org/export/dump';
const DEFAULT_DATA_DIR = path.resolve(process.env.GEOGRAPHY_DATA_DIR || 'data/geography');
const GEONAMES_DATA_DIR = path.resolve(process.env.GEONAMES_DATA_DIR || path.join(DEFAULT_DATA_DIR, 'geonames'));
const INDIA_SCOPE = Object.freeze({ countryIso2: 'IN', countryIso3: 'IND' });

const args = Object.fromEntries(process.argv.slice(3).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length > 0 ? rest.join('=') : true];
}));
const command = process.argv[2] || 'help';
const output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const normalizeScope = ({ country = args.country, iso3 = args.iso3 } = {}) => {
  const countryIso2 = country ? String(country).trim().toUpperCase() : null;
  const countryIso3 = iso3 ? String(iso3).trim().toUpperCase() : null;
  if (countryIso2 && countryIso2 !== INDIA_SCOPE.countryIso2) {
    throw new Error(`Unsupported scoped country import: ${countryIso2}. This safe mode currently supports --country=IN.`);
  }
  if (countryIso3 && countryIso3 !== INDIA_SCOPE.countryIso3) {
    throw new Error(`Unsupported scoped ISO3 import: ${countryIso3}. This safe mode currently supports --iso3=IND.`);
  }
  if (countryIso2 || countryIso3) return INDIA_SCOPE;
  return { countryIso2: null, countryIso3: null };
};

const isIndiaScope = (scope = normalizeScope()) => scope.countryIso2 === INDIA_SCOPE.countryIso2;

const scopedInputScope = ({ source, levels = [], scope = normalizeScope(), extra = null }) => [
  source,
  scope.countryIso2 || 'ALL',
  levels.length ? levels.join('+') : 'all',
  extra,
].filter(Boolean).join(':');

const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const downloadFile = async (url, destination) => {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && !args.force) return { destination, cached: true, checksum: await sha256File(destination) };
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const temporary = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
  await fsp.rename(temporary, destination);
  return { destination, cached: false, checksum: await sha256File(destination) };
};

const pathIfExists = (...parts) => {
  const candidate = path.resolve(...parts);
  return fs.existsSync(candidate) ? candidate : null;
};

const geoNamesPath = (fileName) =>
  pathIfExists(GEONAMES_DATA_DIR, fileName)
  || pathIfExists(DEFAULT_DATA_DIR, fileName)
  || path.resolve(GEONAMES_DATA_DIR, fileName);

const requiredGeoNamesPath = (fileName, errorMessage = null) => {
  const candidate = geoNamesPath(fileName);
  if (!fs.existsSync(candidate)) throw new Error(errorMessage || `GeoNames source file was not found: ${candidate}`);
  return candidate;
};

const selectGeoNamesSourceFile = ({ levels, mode, scope, explicitFile = null } = {}) => {
  if (explicitFile) return path.resolve(explicitFile);
  const requestedLevels = Array.isArray(levels) ? levels : [];
  const onlyCountries = requestedLevels.length === 1 && requestedLevels[0] === 'country';
  if (onlyCountries) return geoNamesPath('countryInfo.txt');
  if (isIndiaScope(scope) && requestedLevels.some((level) => ['state', 'district'].includes(level))) {
    return requiredGeoNamesPath('IN.zip', 'India GeoNames source file was not found. Expected IN.zip or an explicitly supplied India source file.');
  }
  if (isIndiaScope(scope) && requestedLevels.includes('city') && mode === 'all') {
    return requiredGeoNamesPath('IN.zip', 'India GeoNames source file was not found. Expected IN.zip or an explicitly supplied India source file.');
  }
  return geoNamesPath(mode === 'cities500' ? 'cities500.zip' : 'allCountries.zip');
};

const openTextStream = (filePath, entryPattern = null) => {
  if (!String(filePath).toLowerCase().endsWith('.zip')) return fs.createReadStream(filePath);
  const baseName = path.basename(filePath, path.extname(filePath)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = entryPattern ? new RegExp(entryPattern, 'i') : new RegExp(`^${baseName}\\.txt$`, 'i');
  return fs.createReadStream(filePath).pipe(unzipper.ParseOne(matcher));
};

const requiredPath = (name, fallback = null) => {
  const value = args[name] || fallback;
  if (!value) throw new Error(`--${name}=<path> is required`);
  return path.resolve(value);
};

const detectDelimitedFileDelimiter = async (filePath) => {
  const sample = await fsp.readFile(filePath, 'utf8');
  const firstLine = sample.split(/\r?\n/).find((line) => line.trim()) || '';
  const candidates = [
    { delimiter: '\t', count: (firstLine.match(/\t/g) || []).length },
    { delimiter: ',', count: (firstLine.match(/,/g) || []).length },
    { delimiter: ';', count: (firstLine.match(/;/g) || []).length },
    { delimiter: '|', count: (firstLine.match(/\|/g) || []).length },
  ];
  return candidates.sort((a, b) => b.count - a.count)[0]?.delimiter || ',';
};

const buildGeoNamesMaps = async () => loadGeoNamesCodeMaps({
  countryInfoStream: openTextStream(requiredPath('country-info', geoNamesPath('countryInfo.txt'))),
  admin1Stream: openTextStream(requiredPath('admin1', geoNamesPath('admin1CodesASCII.txt'))),
  admin2Stream: openTextStream(requiredPath('admin2', geoNamesPath('admin2Codes.txt'))),
});

const stageGeoNames = async ({ levels }) => {
  const scope = normalizeScope();
  const mode = args['place-mode'] || process.env.GLOBAL_POPULATED_PLACE_MODE || 'all';
  const onlyCountries = levels.length === 1 && levels[0] === 'country';
  const defaultFile = selectGeoNamesSourceFile({ levels, mode, scope });
  const file = requiredPath('file', defaultFile);
  if (isIndiaScope(scope) && levels.includes('city') && mode === 'all' && !/IN\.(txt|zip)$/i.test(path.basename(file))) {
    throw new Error('India --place-mode=all must use IN.zip or an explicitly supplied India source file.');
  }
  if (isIndiaScope(scope) && levels.includes('city') && mode !== 'all' && /allCountries\.zip$/i.test(path.basename(file))) {
    throw new Error('India populated-place import will not use allCountries.zip. Provide IN.zip or cities500.zip.');
  }
  const checksum = await sha256File(file);
  const { batch, reused } = await createImportBatch({
    source: 'GEONAMES',
    sourceVersion: args.version,
    sourceFile: file,
    checksum,
    inputScope: scopedInputScope({ source: 'GEONAMES', levels, scope, extra: `${mode}:zip-entry-v2` }),
  });
  if (reused && batch.status === 'completed') return { batchId: batch.id, reused: true };
  const records = onlyCountries
    ? streamGeoNamesCountryInfoRecords(openTextStream(file), scope)
    : streamGeoNamesRecords(openTextStream(file), {
      maps: await buildGeoNamesMaps(),
      levels,
      countryIso2: scope.countryIso2,
      populatedPlaceMode: mode,
    });
  return stageRecords({ batchId: batch.id, source: 'GEONAMES', records, batchSize: Number(args['batch-size'] || 2000) });
};

const stageLgd = async (options = {}) => {
  const scope = normalizeScope();
  const file = options.file ? path.resolve(options.file) : requiredPath('file');
  const checksum = await sha256File(file);
  const entity = options.entity || args.entity || 'district';
  const delimiter = options.delimiter || args.delimiter || await detectDelimitedFileDelimiter(file);
  const { batch, reused } = await createImportBatch({
    source: 'LGD',
    sourceVersion: options.version || args.version,
    sourceFile: file,
    checksum,
    inputScope: scopedInputScope({ source: 'LGD', levels: [entity], scope, extra: options.version || args.version || null }),
  });
  if (reused && batch.status === 'completed') return { batchId: batch.id, reused: true };
  const records = streamLgdRecords(openTextStream(file), {
    entity,
    delimiter,
    sourceModifiedAt: options.sourceModifiedAt || args['source-modified-at'] || null,
  });
  return stageRecords({ batchId: batch.id, source: 'LGD', records, batchSize: Number(args['batch-size'] || 2000) });
};

const importBoundary = async (options = {}) => {
  const scope = normalizeScope();
  const file = options.file ? path.resolve(options.file) : requiredPath('file');
  const document = JSON.parse(await fsp.readFile(file, 'utf8'));
  const metadataFile = options.metadata || args.metadata;
  const metadata = metadataFile ? JSON.parse(await fsp.readFile(path.resolve(metadataFile), 'utf8')) : {};
  const countryIso3 = options.iso3 || args.iso3;
  const level = options.level || args.level;
  if (!countryIso3 || !level) throw new Error('Boundary import requires iso3 and level');
  if (isIndiaScope(scope) && String(countryIso3).toUpperCase() !== INDIA_SCOPE.countryIso3) {
    throw new Error(`India boundary import only accepts iso3=IND, received ${countryIso3}`);
  }
  const checksum = await sha256File(file);
  const { batch } = await createImportBatch({
    source: 'GEOBOUNDARIES',
    sourceVersion: options.version || args.version,
    sourceFile: file,
    checksum,
    inputScope: scopedInputScope({ source: 'GEOBOUNDARIES', levels: [level], scope, extra: `${countryIso3}:${options.version || args.version || 'current'}` }),
  });
  const summary = await importGeoBoundariesFeatureCollection({
    featureCollection: document,
    metadata,
    countryIso3,
    level,
    batchId: batch.id,
  });
  await batch.update({ status: 'completed', completed_at: new Date(), total_records: summary.total, error_summary: { summary }, updated_at: new Date() });
  return { batchId: batch.id, summary };
};

const readManifest = async (manifestFile, { kind, scope = normalizeScope() } = {}) => {
  const resolved = path.resolve(manifestFile);
  if (!fs.existsSync(resolved)) throw new Error(`${kind} manifest was not found: ${resolved}`);
  const entries = JSON.parse(await fsp.readFile(resolved, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${kind} manifest must be a JSON array`);
  for (const entry of entries) {
    if (!entry.file || !fs.existsSync(path.resolve(entry.file))) {
      throw new Error(`${kind} manifest entry has a missing file: ${entry.file || '<empty>'}`);
    }
    if (kind === 'boundaries') {
      if (!entry.metadata || !fs.existsSync(path.resolve(entry.metadata))) {
        throw new Error(`Boundary manifest entry has a missing metadata file: ${entry.metadata || '<empty>'}`);
      }
      if (!entry.version) throw new Error('Boundary manifest entry must include version');
      if (!['ADM0', 'ADM1', 'ADM2', 'ADM3', 'ADM4'].includes(String(entry.level || '').toUpperCase())) {
        throw new Error(`Boundary manifest entry has unsupported level: ${entry.level}`);
      }
      if (isIndiaScope(scope) && String(entry.iso3 || '').toUpperCase() !== INDIA_SCOPE.countryIso3) {
        throw new Error(`India boundary bootstrap only accepts iso3=IND, received ${entry.iso3 || '<empty>'}`);
      }
      const geojson = JSON.parse(await fsp.readFile(path.resolve(entry.file), 'utf8'));
      if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error(`Boundary manifest file is not usable GeoJSON FeatureCollection: ${entry.file}`);
      }
    }
    if (kind === 'lgd') {
      if (!['state', 'district', 'urban_local_body'].includes(String(entry.entity || '').toLowerCase())) {
        throw new Error(`LGD manifest entry has unsupported entity: ${entry.entity}`);
      }
      if (!entry.version) throw new Error('LGD manifest entry must include version');
    }
  }
  return entries;
};

const validate = async () => {
  const scope = normalizeScope();
  const geographyScopeWhere = isIndiaScope(scope)
    ? { [require('sequelize').Op.or]: [{ country_iso2: 'IN' }, { country_code: 'IN' }] }
    : {};
  const batchScope = isIndiaScope(scope) ? { input_scope: { [require('sequelize').Op.like]: '%IN%' } } : {};
  const [orphaned, duplicateSources, activeByLevel, batches, indiaCountries, nonIndiaBatchRows, invalidCoordinates] = await Promise.all([
    Geography.count({ where: { tenant_id: null, parent_id: null, level: { [require('sequelize').Op.ne]: 'country' }, is_active: true, ...geographyScopeWhere } }),
    sequelize.query('SELECT source, external_code, COUNT(*)::int AS count FROM global_geography_sources GROUP BY source, external_code HAVING COUNT(*) > 1', { type: sequelize.QueryTypes.SELECT }),
    Geography.findAll({ where: { tenant_id: null, is_active: true, ...geographyScopeWhere }, attributes: ['level', [sequelize.fn('COUNT', sequelize.col('id')), 'count']], group: ['level'], raw: true }),
    GlobalGeographyImportBatch.findAll({ where: batchScope, order: [['created_at', 'DESC']], limit: 20, raw: true }),
    isIndiaScope(scope) ? Geography.count({ where: { tenant_id: null, level: 'country', is_active: true, [require('sequelize').Op.or]: [{ country_iso2: 'IN' }, { country_code: 'IN' }, { country_iso3: 'IND' }] } }) : Promise.resolve(null),
    isIndiaScope(scope) ? GlobalGeographyImportStaging.count({ where: { country_iso2: { [require('sequelize').Op.notIn]: ['IN'] }, import_batch_id: { [require('sequelize').Op.in]: sequelize.literal("(SELECT id FROM global_geography_import_batches WHERE input_scope LIKE '%IN%')") } } }) : Promise.resolve(0),
    Geography.count({
      where: {
        tenant_id: null,
        ...geographyScopeWhere,
        [require('sequelize').Op.or]: [
          { latitude: { [require('sequelize').Op.lt]: -90 } },
          { latitude: { [require('sequelize').Op.gt]: 90 } },
          { longitude: { [require('sequelize').Op.lt]: -180 } },
          { longitude: { [require('sequelize').Op.gt]: 180 } },
        ],
      },
    }),
  ]);
  const valid = orphaned === 0
    && duplicateSources.length === 0
    && invalidCoordinates === 0
    && (!isIndiaScope(scope) || (indiaCountries === 1 && nonIndiaBatchRows === 0));
  return {
    valid,
    scope: scope.countryIso2 || 'ALL',
    indiaCountries,
    orphaned,
    invalidCoordinates,
    nonIndiaBatchRows,
    duplicateSources,
    activeByLevel,
    batches,
  };
};

const report = async () => {
  const scope = normalizeScope();
  const geographyScopeWhere = isIndiaScope(scope)
    ? { [require('sequelize').Op.or]: [{ country_iso2: 'IN' }, { country_code: 'IN' }] }
    : {};
  const batchScope = isIndiaScope(scope) ? { input_scope: { [require('sequelize').Op.like]: '%IN%' } } : {};
  const validation = await validate();
  const [staging, sources, counts, aliases, batches] = await Promise.all([
    GlobalGeographyImportStaging.findAll({
      where: isIndiaScope(scope) ? { country_iso2: 'IN' } : {},
    attributes: ['validation_status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    group: ['validation_status'],
    raw: true,
    }),
    GlobalGeographySource.findAll({
    attributes: ['source', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    group: ['source'],
    raw: true,
    }),
    Geography.findAll({ where: { tenant_id: null, ...geographyScopeWhere }, attributes: ['level', [sequelize.fn('COUNT', sequelize.col('id')), 'count']], group: ['level'], raw: true }),
    GlobalGeographyAlias.count({
      include: isIndiaScope(scope) ? [{
        model: Geography,
        as: 'globalGeography',
        attributes: [],
        required: true,
        where: { tenant_id: null, [require('sequelize').Op.or]: [{ country_iso2: 'IN' }, { country_code: 'IN' }] },
      }] : [],
    }),
    GlobalGeographyImportBatch.findAll({ where: batchScope, order: [['created_at', 'DESC']], limit: 10, raw: true }),
  ]);
  const status = validation.valid
    ? (validation.orphaned || validation.duplicateSources.length ? 'succeeded_with_warnings' : 'succeeded')
    : 'failed';
  return { status, scope: scope.countryIso2 || 'ALL', validation, counts, aliases, staging, sources, batches };
};

const commands = {
  async download() {
    const scope = normalizeScope();
    const mode = args['place-mode'] || process.env.GLOBAL_POPULATED_PLACE_MODE || 'all';
    const placeFile = isIndiaScope(scope)
      ? (mode === 'cities500' ? 'cities500.zip' : 'IN.zip')
      : (mode === 'cities500' ? 'cities500.zip' : 'allCountries.zip');
    const files = ['countryInfo.txt', 'admin1CodesASCII.txt', 'admin2Codes.txt', 'featureCodes_en.txt', 'timeZones.txt', 'alternateNamesV2.zip'];
    if (isIndiaScope(scope)) files.push('IN.zip');
    files.push(placeFile);
    const uniqueFiles = [...new Set(files)];
    const results = [];
    for (const file of uniqueFiles) results.push(await downloadFile(`${BASE_URL}/${file}`, path.join(GEONAMES_DATA_DIR, file)));
    return {
      scope: scope.countryIso2 || 'ALL',
      results,
      lgd: isIndiaScope(scope) ? 'skipped: provide authorized LGD files manually; this command does not bypass controlled downloads' : undefined,
      boundaries: isIndiaScope(scope) ? 'skipped: provide geoBoundaries files through --boundaries-manifest during bootstrap' : undefined,
    };
  },
  async 'stage:countries'() { return stageGeoNames({ levels: ['country'] }); },
  async 'stage:admin'() { return stageGeoNames({ levels: ['state', 'district'] }); },
  async 'stage:places'() { return stageGeoNames({ levels: ['city'] }); },
  async 'stage:lgd'() { return stageLgd(); },
  async stage() {
    if (String(args.source || 'GEONAMES').toUpperCase() === 'LGD') return stageLgd();
    const levels = String(args.levels || 'country,state,district,city').split(',').map((value) => value.trim()).filter(Boolean);
    return stageGeoNames({ levels });
  },
  async import() {
    if (!args.batch) throw new Error('--batch=<uuid> is required');
    return importStagedBatch({ batchId: args.batch, retireMissing: args['retire-missing'] === 'true' });
  },
  async boundaries() { return importBoundary(); },
  async aliases() {
    const scope = normalizeScope();
    const file = requiredPath('file', geoNamesPath('alternateNamesV2.zip'));
    return importGeoNamesAliases(streamGeoNamesAlternateNames(openTextStream(file)), { countryIso2: scope.countryIso2 });
  },
  async 'sync-level'() {
    const levels = String(args.levels || 'country,state,district,city').split(',').map((value) => value.trim()).filter(Boolean);
    const staged = await stageGeoNames({ levels });
    return importStagedBatch({ batchId: staged.batchId, retireMissing: args['retire-missing'] === 'true' });
  },
  async 'sync-lgd'() {
    const staged = await stageLgd();
    return importStagedBatch({ batchId: staged.batchId, retireMissing: args['retire-missing'] === 'true' });
  },
  async sync() {
    const staged = await stageGeoNames({ levels: ['country', 'state', 'district', 'city'] });
    const imported = await importStagedBatch({ batchId: staged.batchId });
    let retired = 0;
    if (args.deletes) {
      const deletes = [];
      for await (const row of streamGeoNamesDeletes(openTextStream(path.resolve(args.deletes)))) deletes.push(row.externalCode);
      retired = await markSourceRecordsInactive({ source: 'GEONAMES', externalCodes: deletes, batchId: staged.batchId });
    }
    return { imported, retired };
  },
  async deletes() {
    const deletes = [];
    for await (const row of streamGeoNamesDeletes(openTextStream(requiredPath('file')))) deletes.push(row.externalCode);
    return { retired: await markSourceRecordsInactive({ source: 'GEONAMES', externalCodes: deletes, batchId: args.batch || null }) };
  },
  validate,
  report,
  async bootstrap() {
    const scope = normalizeScope();
    await commands.download();
    const results = [];
    for (const levels of [['country'], ['state', 'district'], ['city']]) {
      const staged = await stageGeoNames({ levels });
      results.push(await importStagedBatch({ batchId: staged.batchId }));
    }
    results.push({ aliases: await commands.aliases() });
    const boundaryManifestFile = args['boundaries-manifest'] || process.env.GEOGRAPHY_BOUNDARY_MANIFEST;
    const lgdManifestFile = args['lgd-manifest'] || process.env.GEOGRAPHY_LGD_MANIFEST;
    if (boundaryManifestFile) {
      const entries = await readManifest(boundaryManifestFile, { kind: 'boundaries', scope });
      for (const entry of entries) results.push({ boundary: await importBoundary(entry) });
    } else {
      results.push({ boundaries: 'skipped: provide --boundaries-manifest or GEOGRAPHY_BOUNDARY_MANIFEST' });
    }
    if (lgdManifestFile) {
      const entries = await readManifest(lgdManifestFile, { kind: 'lgd', scope });
      for (const entry of entries) {
        const staged = await stageLgd(entry);
        results.push({ lgd: await importStagedBatch({ batchId: staged.batchId }) });
      }
    } else {
      results.push({ lgd: 'skipped: provide --lgd-manifest or GEOGRAPHY_LGD_MANIFEST' });
    }
    return { results, report: await report() };
  },
};

const main = async () => {
  if (!commands[command]) throw new Error(`Unknown command: ${command}`);
  const result = await commands[command]();
  output(result);
  if (command === 'validate' && result?.valid === false) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }).finally(async () => sequelize.close());
}

module.exports = {
  normalizeScope,
  geoNamesPath,
  requiredGeoNamesPath,
  selectGeoNamesSourceFile,
  detectDelimitedFileDelimiter,
  readManifest,
  commands,
};
