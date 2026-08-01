'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  Geography,
  GlobalGeographySource,
  GeographyMigrationReview,
  TenantGeographyAssignment,
} = require('../src/models');

const OFFICIAL_LEVELS = ['country', 'state', 'district', 'city'];
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length > 0 ? rest.join('=') : true];
}));

const normalizeScope = () => {
  const country = args.country ? String(args.country).trim().toUpperCase() : null;
  const iso3 = args.iso3 ? String(args.iso3).trim().toUpperCase() : null;
  if (country && country !== 'IN') throw new Error(`Unsupported scoped linking country: ${country}. Use --country=IN for India-first linking.`);
  if (iso3 && iso3 !== 'IND') throw new Error(`Unsupported scoped linking ISO3: ${iso3}. Use --iso3=IND for India-first linking.`);
  return country || iso3 ? { countryIso2: 'IN', countryIso3: 'IND' } : { countryIso2: null, countryIso3: null };
};

const indiaNameFilterForLegacy = (legacy) => {
  const text = [
    legacy.country_iso2,
    legacy.country_code,
    legacy.country_name,
    legacy.state_name,
    legacy.district_name,
    legacy.city_name,
    legacy.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\bin\b|india|madhya pradesh|maharashtra|indore|nashik|mhow/.test(text);
};

const findCandidates = async (legacy, transaction, scope) => {
  if (legacy.master_geography_id || legacy.global_geography_id) {
    const direct = await Geography.findByPk(legacy.global_geography_id || legacy.master_geography_id, { transaction });
    if (scope.countryIso2 && direct && ![direct.country_iso2, direct.country_code].includes(scope.countryIso2)) return [];
    return direct?.tenant_id === null ? [direct] : [];
  }
  if (legacy.external_source && legacy.external_code) {
    const source = await GlobalGeographySource.findOne({
      where: { source: String(legacy.external_source).toUpperCase(), external_code: legacy.external_code },
      transaction,
    });
    if (source) {
      const global = await Geography.findByPk(source.global_geography_id, { transaction });
      if (scope.countryIso2 && global && ![global.country_iso2, global.country_code].includes(scope.countryIso2)) return [];
      return [global].filter(Boolean);
    }
  }
  let parentGlobalId = null;
  if (legacy.parent_id) {
    const parent = await Geography.findByPk(legacy.parent_id, { attributes: ['global_geography_id', 'master_geography_id'], transaction });
    parentGlobalId = parent?.global_geography_id || parent?.master_geography_id || null;
  }
  const where = {
    tenant_id: null,
    level: legacy.level,
    normalized_name: legacy.normalized_name,
    is_active: true,
    ...(parentGlobalId ? { parent_id: parentGlobalId } : {}),
    ...(scope.countryIso2 ? { [Op.or]: [{ country_iso2: scope.countryIso2 }, { country_code: scope.countryIso2 }] } : {}),
  };
  if (legacy.place_id || legacy.map_place_id || legacy.external_place_id) {
    const placeId = legacy.external_place_id || legacy.map_place_id || legacy.place_id;
    where[Op.or] = [
      { external_place_id: placeId },
      { map_place_id: placeId },
      { place_id: placeId },
      { normalized_name: legacy.normalized_name },
    ];
  }
  return Geography.findAll({ where, limit: 10, transaction });
};

const main = async () => {
  const scope = normalizeScope();
  const summary = { total: 0, matched: 0, ambiguous: 0, unmatched: 0 };
  await sequelize.transaction(async (transaction) => {
    for (const level of OFFICIAL_LEVELS) {
      let rows = await Geography.findAll({
        where: { tenant_id: { [Op.ne]: null }, level, global_geography_id: null },
        order: [['created_at', 'ASC']],
        transaction,
      });
      if (scope.countryIso2) rows = rows.filter(indiaNameFilterForLegacy);
      for (const legacy of rows) {
        summary.total += 1;
        const candidates = (await findCandidates(legacy, transaction, scope)).filter(Boolean);
        if (candidates.length === 1) {
          const global = candidates[0];
          await legacy.update({
            global_geography_id: global.id,
            master_geography_id: legacy.master_geography_id || global.id,
            updated_at: new Date(),
          }, { transaction });
          await TenantGeographyAssignment.upsert({
            tenant_id: legacy.tenant_id,
            geography_id: global.id,
            is_enabled: true,
            created_by_user_id: null,
            updated_at: new Date(),
          }, { transaction });
          summary.matched += 1;
        } else if (candidates.length > 1) {
          await GeographyMigrationReview.findOrCreate({
            where: { legacy_geography_id: legacy.id },
            defaults: {
              id: crypto.randomUUID(),
              tenant_id: legacy.tenant_id,
              candidate_master_geography_ids: candidates.map((candidate) => candidate.id),
              match_method: 'global_parent_level_normalized_name',
              status: 'pending',
              notes: 'Ambiguous global geography migration match',
            },
            transaction,
          });
          summary.ambiguous += 1;
        } else {
          summary.unmatched += 1;
        }
      }
    }
  });
  process.stdout.write(`${JSON.stringify({ scope: scope.countryIso2 || 'ALL', ...summary }, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(async () => sequelize.close());
