'use strict';

const { Op } = require('sequelize');
const { GlobalGeographySource, GlobalGeographyAlias, Geography } = require('../../models');
const { normalizeName } = require('./normalization');

const importGeoNamesAliases = async (records, { batchSize = 3000, countryIso2 = null } = {}) => {
  let buffer = [];
  let inserted = 0;
  let skipped = 0;
  const flush = async () => {
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = [];
    const sourceCodes = [...new Set(chunk.map((row) => row.geographyExternalCode))];
    const include = countryIso2 ? [{
      model: Geography,
      as: 'globalGeography',
      attributes: [],
      required: true,
      where: {
        tenant_id: null,
        [Op.or]: [
          { country_iso2: String(countryIso2).toUpperCase() },
          { country_code: String(countryIso2).toUpperCase() },
        ],
      },
    }] : [];
    const sources = await GlobalGeographySource.findAll({
      where: { source: 'GEONAMES', external_code: { [Op.in]: sourceCodes } },
      include,
      attributes: ['external_code', 'global_geography_id'],
      raw: true,
    });
    const geographyByCode = new Map(sources.map((row) => [String(row.external_code), row.global_geography_id]));
    const payloads = chunk.map((row) => {
      const geographyId = geographyByCode.get(String(row.geographyExternalCode));
      if (!geographyId) return null;
      return {
        global_geography_id: geographyId,
        name: row.name,
        normalized_name: normalizeName(row.name),
        language_code: row.languageCode,
        is_preferred: row.isPreferred,
        is_short_name: row.isShortName,
        is_historic: row.isHistoric,
        source: 'GEONAMES',
        external_code: row.externalCode,
        updated_at: new Date(),
      };
    }).filter(Boolean);
    skipped += chunk.length - payloads.length;
    if (payloads.length > 0) {
      await GlobalGeographyAlias.bulkCreate(payloads, {
        ignoreDuplicates: true,
      });
      inserted += payloads.length;
    }
  };
  for await (const record of records) {
    buffer.push(record);
    if (buffer.length >= batchSize) await flush();
  }
  await flush();
  return { inserted, skipped };
};

module.exports = { importGeoNamesAliases };
