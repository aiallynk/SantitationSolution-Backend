'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { parseDelimitedLine, streamDelimitedRows } = require('../src/modules/geography-master/delimited-stream');
const { classifyGeoNamesFeature, normalizeCoordinates, normalizeName, shouldPreferSource } = require('../src/modules/geography-master/normalization');
const { streamGeoNamesCountryInfoRecords, streamGeoNamesRecords } = require('../src/modules/geography-master/geonames.adapter');
const { streamLgdRecords } = require('../src/modules/geography-master/lgd.adapter');
const { geometryMetrics, simplifyGeometry } = require('../src/modules/geography-master/boundary.service');
const { copyGlobalGeography } = require('../src/modules/geography-master/activation.service');
const { classifyLegacyDistrict } = require('../src/modules/geography-master/india-district-reconciliation.service');
const { isOfficialIndiaSelectionRequest } = require('../src/modules/platform/platform.service');
const { parseArgs } = require('../scripts/reconcile-india-districts');

const collect = async (iterable) => {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
};

test('delimited parser handles quoted commas without loading a file', () => {
  assert.deepEqual(parseDelimitedLine('1,"Nashik, Maharashtra",active'), ['1', 'Nashik, Maharashtra', 'active']);
});

test('streaming rows skips comments and preserves headers', async () => {
  const rows = await collect(streamDelimitedRows(Readable.from('# comment\ncode\tname\n1\tIndia\n'), { delimiter: '\t' }));
  assert.deepEqual(rows, [{ code: '1', name: 'India' }]);
});

test('GeoNames feature classification excludes historic places', () => {
  assert.equal(classifyGeoNamesFeature({ featureClass: 'P', featureCode: 'PPLH' }), null);
  assert.equal(classifyGeoNamesFeature({ featureClass: 'A', featureCode: 'ADM1' }).level, 'state');
  assert.equal(classifyGeoNamesFeature({ featureClass: 'P', featureCode: 'PPLA2' }).level, 'city');
});

test('GeoNames ADM2 resolves its parent from the ADM1 code map', async () => {
  const line = ['1261731', 'Nashik', 'Nashik', '', '20.0', '73.8', 'A', 'ADM2', 'IN', '', '16', '516', '', '', '0', '', '', 'Asia/Kolkata', '2026-01-01'].join('\t');
  const maps = {
    countries: new Map([['IN', { iso2: 'IN', iso3: 'IND', geonameid: '1269750' }]]),
    admin1: new Map([['IN.16', '1264418']]),
    admin2: new Map(),
  };
  const [row] = await collect(streamGeoNamesRecords(Readable.from(`${line}\n`), { maps }));
  assert.equal(row.externalCode, '1261731');
  assert.equal(row.parentExternalCode, '1264418');
  assert.equal(row.normalizedLevel, 'district');
});

test('GeoNames countryInfo stream can import India without allCountries', async () => {
  const countryInfo = [
    'IN', 'IND', '356', 'IN', 'India', 'New Delhi', '3287590', '1400000000',
    'AS', '.in', 'INR', 'Rupee', '91', '', '', 'hi,en', '1269750', 'NP,CN', '',
  ].join('\t');
  const [row] = await collect(streamGeoNamesCountryInfoRecords(Readable.from(`${countryInfo}\n`), { countryIso2: 'IN' }));
  assert.equal(row.name, 'India');
  assert.equal(row.externalCode, '1269750');
  assert.equal(row.normalizedLevel, 'country');
  assert.equal(row.countryIso3, 'IND');
});

test('India-scoped GeoNames stream imports no non-India administrative or place rows', async () => {
  const india = ['1261731', 'Nashik', 'Nashik', '', '20.0', '73.8', 'A', 'ADM2', 'IN', '', '16', '516', '', '', '0', '', '', 'Asia/Kolkata', '2026-01-01'].join('\t');
  const france = ['2996944', 'Lyon', 'Lyon', '', '45.7', '4.8', 'P', 'PPLA', 'FR', '', '84', '69', '', '', '0', '', '', 'Europe/Paris', '2026-01-01'].join('\t');
  const maps = {
    countries: new Map([['IN', { iso2: 'IN', iso3: 'IND', geonameid: '1269750' }], ['FR', { iso2: 'FR', iso3: 'FRA', geonameid: '3017382' }]]),
    admin1: new Map([['IN.16', '1264418'], ['FR.84', '2975249']]),
    admin2: new Map(),
  };
  const rows = await collect(streamGeoNamesRecords(Readable.from(`${india}\n${france}\n`), { maps, countryIso2: 'IN', levels: ['district', 'city'] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].countryIso2, 'IN');
});

test('LGD adapter preserves official identity and parent code', async () => {
  const csv = 'District Code,District Name(In English),State Code,Status\n516,Nashik,27,Active\n';
  const [row] = await collect(streamLgdRecords(Readable.from(csv), { entity: 'district' }));
  assert.equal(row.source, 'LGD');
  assert.equal(row.externalCode, 'district:516');
  assert.equal(row.parentExternalCode, 'state:27');
  assert.equal(row.countryIso2, 'IN');
});

test('LGD adapter parses detected tab delimiter and current State header variants', async () => {
  const tsv = [
    'S No\tState LGD Code\tState Name (In English)\tState or UT\tCensus2011 Code',
    '1\t04\tChandigarh\tUT\t04',
  ].join('\n');
  const [row] = await collect(streamLgdRecords(Readable.from(tsv), { entity: 'state', delimiter: 'tab' }));
  assert.equal(row.externalCode, 'state:04');
  assert.equal(row.rawPayload.lgdCode, '04');
  assert.equal(row.name, 'Chandigarh');
  assert.equal(row.rawPayload.stateOrUt, 'UT');
});

test('LGD adapter parses current District header variants without code collisions', async () => {
  const tsv = [
    'S No\tState Code\tState Name\tDistrict LGD Code\tDistrict Name (In English)\tCensus2011 Code',
    '1\t27\tMaharashtra(State)\t516\tNashik\t516',
  ].join('\n');
  const [row] = await collect(streamLgdRecords(Readable.from(tsv), { entity: 'district', delimiter: '\t' }));
  assert.equal(row.externalCode, 'district:516');
  assert.equal(row.parentExternalCode, 'state:27');
  assert.equal(row.rawPayload.lgdCode, '516');
  assert.equal(row.rawPayload.parentLgdCode, '27');
});

test('invalid coordinate pairs are rejected', () => {
  assert.ok(normalizeCoordinates('91', '73').error);
  assert.ok(normalizeCoordinates('20', '').error);
  assert.deepEqual(normalizeCoordinates('20.1', '73.8'), { latitude: 20.1, longitude: 73.8, error: null });
});

test('boundary metrics produce bounds and simplification retains geometry type', () => {
  const geometry = { type: 'Polygon', coordinates: [[[72, 19], [74, 19], [74, 21], [72, 21], [72, 19]]] };
  assert.deepEqual(geometryMetrics(geometry).bounds, { north: 21, south: 19, east: 74, west: 72 });
  assert.equal(simplifyGeometry(geometry, 4).type, 'Polygon');
});

test('LGD outranks GeoNames for canonical identity', () => {
  assert.equal(shouldPreferSource('GEONAMES', 'LGD'), true);
  assert.equal(shouldPreferSource('LGD', 'GEONAMES'), false);
  assert.equal(normalizeName('Nashik District'), 'nashik district');
});

test('tenant activation payload links the global ID without replacing it', () => {
  const global = {
    id: 'global-id', code: 'GN-1', name: 'Nashik', level: 'district', parent_id: 'state-id',
    normalized_name: 'nashik', alternate_names: [], is_active: true, is_official_source: true,
    is_verified_local_government: true, quality_status: 'verified',
  };
  const payload = copyGlobalGeography(global, { tenantId: 'tenant-id', parentId: 'tenant-state-id', createdBy: 'actor-id' });
  assert.equal(payload.global_geography_id, 'global-id');
  assert.equal(payload.master_geography_id, 'global-id');
  assert.equal(payload.parent_id, 'tenant-state-id');
  assert.equal(global.id, 'global-id');
});

test('India source selection never falls back to allCountries for all-place mode', () => {
  const { selectGeoNamesSourceFile } = require('../scripts/geography-master');
  let indiaAllFile = null;
  try {
    indiaAllFile = selectGeoNamesSourceFile({
      levels: ['city'],
      mode: 'all',
      scope: { countryIso2: 'IN', countryIso3: 'IND' },
    });
  } catch (error) {
    assert.match(error.message, /India GeoNames source file was not found/);
  }
  if (indiaAllFile) assert.match(indiaAllFile, /IN\.zip$/);
  const cities500File = selectGeoNamesSourceFile({
    levels: ['city'],
    mode: 'cities500',
    scope: { countryIso2: 'IN', countryIso3: 'IND' },
  });
  assert.match(cities500File, /cities500\.zip$/);
});

test('officialOnly filters India State and District selections only', () => {
  assert.equal(isOfficialIndiaSelectionRequest({ officialOnly: true, countryCode: 'IN', level: 'state' }), true);
  assert.equal(isOfficialIndiaSelectionRequest({ officialOnly: 'true', countryCode: 'in', level: 'district' }), true);
  assert.equal(isOfficialIndiaSelectionRequest({ officialOnly: true, countryCode: 'IN', level: 'city' }), false);
  assert.equal(isOfficialIndiaSelectionRequest({ officialOnly: false, countryCode: 'IN', level: 'district' }), false);
  assert.equal(isOfficialIndiaSelectionRequest({ officialOnly: true, countryCode: 'AU', level: 'district' }), false);
});

test('India district reconciliation dry-run defaults to no mutation', () => {
  assert.deepEqual(parseArgs([]), { dryRun: true, apply: false, reviewFile: null });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, apply: false, reviewFile: null });
});

test('reconciliation classification hides divisions and keeps ambiguous split rows manual', () => {
  const division = classifyLegacyDistrict({ name: 'Nashik Division' }, []);
  assert.equal(division.classification, 'administrative division rather than District');
  assert.equal(division.confidence, 'high');

  const ambiguous = classifyLegacyDistrict({ name: 'Aurangabad' }, [
    { id: 'candidate-1', name: 'Aurangabad', matchReason: 'same-state partial name overlap', confidence: 'low' },
    { id: 'candidate-2', name: 'Chhatrapati Sambhajinagar', matchReason: 'known same-state rename', confidence: 'medium' },
  ]);
  assert.equal(ambiguous.classification, 'split/merged District requiring manual review');
  assert.match(ambiguous.recommendedAction, /manual review/i);
});

test('reconciliation classification permits only exact same-state matches as high-confidence candidates', () => {
  const exact = classifyLegacyDistrict({ name: 'Nashik' }, [
    { id: 'lgd-nashik', name: 'Nashik', matchReason: 'same-state normalized name match', confidence: 'high' },
  ]);
  assert.equal(exact.classification, 'exact renamed/alias match');
  assert.equal(exact.confidence, 'high');
});
