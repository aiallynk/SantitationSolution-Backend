'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sequelize } = require('../src/models');
const { runGeographyImportJob } = require('../src/modules/platform/platform.service');

const readArg = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
};

const parseDelimitedLine = (line, delimiter) => {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
};

const parseDelimited = (content, delimiter) => {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseDelimitedLine(lines[0], delimiter).map((header) => header.trim());
  return lines.slice(1).map((line) => Object.fromEntries(
    parseDelimitedLine(line, delimiter).map((value, index) => [headers[index], value.trim()])
  ));
};

const firstValue = (row, keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && String(row[key]).trim()) return String(row[key]).trim();
  }
  return null;
};

const normalizeRow = (row, defaults) => ({
  name: firstValue(row, ['name', 'Name', 'localBodyNameEnglish', 'districtNameEnglish', 'stateNameEnglish']),
  level: firstValue(row, ['level', 'normalizedLevel']) || defaults.level,
  externalSource: firstValue(row, ['externalSource', 'source']) || defaults.source,
  externalCode: firstValue(row, ['externalCode', 'code', 'lgdCode', 'geonameid']),
  parentExternalSource: firstValue(row, ['parentExternalSource']) || defaults.parentSource || defaults.source,
  parentExternalCode: firstValue(row, ['parentExternalCode', 'parentCode']),
  countryCode: firstValue(row, ['countryCode', 'country_code']) || defaults.countryCode,
  administrativeType: firstValue(row, ['administrativeType', 'administrative_type']),
  sourceAdministrativeLevel: firstValue(row, ['sourceAdministrativeLevel', 'source_administrative_level', 'featureCode']),
  latitude: firstValue(row, ['latitude', 'lat']),
  longitude: firstValue(row, ['longitude', 'lng', 'lon']),
  mapPlaceId: firstValue(row, ['mapPlaceId', 'placeId']),
  mapDisplayAddress: firstValue(row, ['mapDisplayAddress', 'displayAddress']),
  overrideExternalSource: firstValue(row, ['overrideExternalSource']),
  overrideExternalCode: firstValue(row, ['overrideExternalCode']),
  isOfficialSource: true,
  isPlatformManaged: true,
  isVerifiedLocalGovernment: defaults.source.toLowerCase() === 'lgd',
});

const main = async () => {
  const file = readArg('file');
  const source = readArg('source');
  const level = readArg('level');
  const countryCode = readArg('country-code');
  const requestedByUserId = readArg('requested-by', process.env.GEOGRAPHY_IMPORT_USER_ID);
  if (!file || !source || !level || !requestedByUserId) {
    throw new Error('Required: --file, --source, --level, and --requested-by (or GEOGRAPHY_IMPORT_USER_ID)');
  }

  const absoluteFile = path.resolve(file);
  const content = fs.readFileSync(absoluteFile, 'utf8');
  const extension = path.extname(absoluteFile).toLowerCase();
  let rawRows;
  if (extension === '.json') {
    const parsed = JSON.parse(content);
    rawRows = Array.isArray(parsed) ? parsed : parsed.records;
  } else if (extension === '.ndjson' || extension === '.jsonl') {
    rawRows = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } else {
    rawRows = parseDelimited(content, extension === '.tsv' ? '\t' : ',');
  }
  if (!Array.isArray(rawRows) || rawRows.length === 0) throw new Error('Dataset contains no records');

  const records = rawRows.map((row) => normalizeRow(row, {
    source,
    level,
    countryCode,
    parentSource: readArg('parent-source'),
  }));
  const fileHash = crypto.createHash('sha256').update(content).digest('hex');
  const result = await runGeographyImportJob({
    user: { id: requestedByUserId, isSuperAdmin: true },
    body: {
      source,
      level,
      countryCode,
      fullSync: readArg('full-sync', 'false') === 'true',
      idempotencyKey: `${source}:${level}:${countryCode || 'global'}:${fileHash}`,
      records,
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
