'use strict';

const { streamDelimitedRows } = require('./delimited-stream');
const { classifyGeoNamesFeature } = require('./normalization');

const GEONAMES_HEADERS = [
  'geonameid', 'name', 'asciiname', 'alternatenames', 'latitude', 'longitude',
  'featureClass', 'featureCode', 'countryCode', 'cc2', 'admin1Code', 'admin2Code',
  'admin3Code', 'admin4Code', 'population', 'elevation', 'dem', 'timezone', 'modificationDate',
];

const COUNTRY_INFO_HEADERS = [
  'iso2', 'iso3', 'isoNumeric', 'fips', 'country', 'capital', 'areaSqKm', 'population',
  'continent', 'tld', 'currencyCode', 'currencyName', 'phone', 'postalCodeFormat',
  'postalCodeRegex', 'languages', 'geonameid', 'neighbours', 'equivalentFipsCode',
];
const ALTERNATE_NAME_HEADERS = [
  'alternateNameId', 'geonameid', 'isolanguage', 'alternateName', 'isPreferredName',
  'isShortName', 'isColloquial', 'isHistoric', 'from', 'to',
];

async function loadGeoNamesCodeMaps({ countryInfoStream, admin1Stream, admin2Stream }) {
  const countries = new Map();
  const admin1 = new Map();
  const admin2 = new Map();
  if (countryInfoStream) {
    for await (const row of streamDelimitedRows(countryInfoStream, { delimiter: '\t', headers: COUNTRY_INFO_HEADERS })) {
      countries.set(row.iso2, row);
    }
  }
  if (admin1Stream) {
    for await (const row of streamDelimitedRows(admin1Stream, { delimiter: '\t', headers: ['code', 'name', 'asciiName', 'geonameid'] })) {
      admin1.set(row.code, row.geonameid);
    }
  }
  if (admin2Stream) {
    for await (const row of streamDelimitedRows(admin2Stream, { delimiter: '\t', headers: ['code', 'name', 'asciiName', 'geonameid'] })) {
      admin2.set(row.code, row.geonameid);
    }
  }
  return { countries, admin1, admin2 };
}

const resolveParentCode = (row, level, maps) => {
  if (level === 'country') return null;
  if (level === 'state') return maps.countries.get(row.countryCode)?.geonameid || null;
  if (level === 'district') return maps.admin1.get(`${row.countryCode}.${row.admin1Code}`) || null;
  return maps.admin2.get(`${row.countryCode}.${row.admin1Code}.${row.admin2Code}`)
    || maps.admin1.get(`${row.countryCode}.${row.admin1Code}`)
    || maps.countries.get(row.countryCode)?.geonameid
    || null;
};

async function* streamGeoNamesRecords(stream, { maps, populatedPlaceMode = 'all', countryIso2 = null, levels = null } = {}) {
  const codeMaps = maps || { countries: new Map(), admin1: new Map(), admin2: new Map() };
  for await (const row of streamDelimitedRows(stream, { delimiter: '\t', headers: GEONAMES_HEADERS })) {
    if (countryIso2 && row.countryCode !== countryIso2) continue;
    const classification = classifyGeoNamesFeature({
      featureClass: row.featureClass,
      featureCode: row.featureCode,
      populatedPlaceMode,
    });
    if (!classification) continue;
    if (Array.isArray(levels) && levels.length > 0 && !levels.includes(classification.level)) continue;
    const country = codeMaps.countries.get(row.countryCode);
    yield {
      source: 'GEONAMES',
      externalCode: row.geonameid,
      parentExternalCode: resolveParentCode(row, classification.level, codeMaps),
      name: row.name,
      normalizedLevel: classification.level,
      rawLevel: row.featureCode,
      administrativeType: classification.administrativeType,
      countryIso2: row.countryCode || country?.iso2 || null,
      countryIso3: country?.iso3 || null,
      admin1Code: row.admin1Code || null,
      admin2Code: row.admin2Code || null,
      admin3Code: row.admin3Code || null,
      admin4Code: row.admin4Code || null,
      latitude: row.latitude,
      longitude: row.longitude,
      rawPayload: {
        asciiName: row.asciiname || null,
        alternateNames: row.alternatenames ? row.alternatenames.split(',').filter(Boolean) : [],
        featureClass: row.featureClass,
        featureCode: row.featureCode,
        population: row.population || country?.population || null,
        elevation: row.elevation || null,
        timezone: row.timezone || null,
        sourceModifiedAt: row.modificationDate || null,
        countryInfo: classification.level === 'country' && country ? {
          capital: country.capital || null,
          continent: country.continent || null,
          areaSqKm: country.areaSqKm || null,
          languages: country.languages || null,
          neighbours: country.neighbours || null,
        } : null,
      },
    };
  }
}

async function* streamGeoNamesCountryInfoRecords(stream, { countryIso2 = null, countryIso3 = null } = {}) {
  const iso2Filter = countryIso2 ? String(countryIso2).toUpperCase() : null;
  const iso3Filter = countryIso3 ? String(countryIso3).toUpperCase() : null;
  for await (const row of streamDelimitedRows(stream, { delimiter: '\t', headers: COUNTRY_INFO_HEADERS })) {
    if (!row.iso2 || !row.country || !row.geonameid) continue;
    if (iso2Filter && row.iso2 !== iso2Filter) continue;
    if (iso3Filter && row.iso3 !== iso3Filter) continue;
    yield {
      source: 'GEONAMES',
      externalCode: row.geonameid,
      parentExternalCode: null,
      name: row.country,
      normalizedLevel: 'country',
      rawLevel: 'PCLI',
      administrativeType: 'country',
      countryIso2: row.iso2,
      countryIso3: row.iso3 || null,
      latitude: null,
      longitude: null,
      rawPayload: {
        featureClass: 'A',
        featureCode: 'PCLI',
        population: row.population || null,
        sourceModifiedAt: null,
        countryInfo: {
          capital: row.capital || null,
          continent: row.continent || null,
          areaSqKm: row.areaSqKm || null,
          languages: row.languages || null,
          neighbours: row.neighbours || null,
        },
      },
    };
  }
}

async function* streamGeoNamesDeletes(stream) {
  for await (const row of streamDelimitedRows(stream, { delimiter: '\t', headers: ['geonameid', 'name', 'comment'] })) {
    if (row.geonameid) yield { source: 'GEONAMES', externalCode: row.geonameid, name: row.name, comment: row.comment };
  }
}

async function* streamGeoNamesAlternateNames(stream) {
  for await (const row of streamDelimitedRows(stream, { delimiter: '\t', headers: ALTERNATE_NAME_HEADERS })) {
    if (!row.alternateNameId || !row.geonameid || !row.alternateName) continue;
    yield {
      externalCode: row.alternateNameId,
      geographyExternalCode: row.geonameid,
      name: row.alternateName,
      languageCode: row.isolanguage || null,
      isPreferred: row.isPreferredName === '1',
      isShortName: row.isShortName === '1',
      isHistoric: row.isHistoric === '1',
    };
  }
}

module.exports = {
  GEONAMES_HEADERS,
  COUNTRY_INFO_HEADERS,
  loadGeoNamesCodeMaps,
  streamGeoNamesCountryInfoRecords,
  streamGeoNamesRecords,
  streamGeoNamesDeletes,
  streamGeoNamesAlternateNames,
};
