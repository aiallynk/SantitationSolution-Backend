'use strict';

const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { sequelize, Geography, Tenant, TenantGeographyAssignment } = require('../../models');

const assertTenantAuthorization = ({ actor, tenantId }) => {
  if (actor?.isSuperAdmin) return;
  if (!actor?.tenantId || String(actor.tenantId) !== String(tenantId)) {
    const error = new Error('Global geography activation is outside tenant scope');
    error.status = 403;
    error.code = 'TENANT_SCOPE_FORBIDDEN';
    throw error;
  }
};

const copyGlobalGeography = (globalRow, { tenantId, parentId, createdBy }) => ({
  tenant_id: tenantId,
  parent_id: parentId,
  master_geography_id: globalRow.id,
  global_geography_id: globalRow.id,
  level: globalRow.level,
  code: `${globalRow.code}-${String(tenantId).slice(0, 8)}`.slice(0, 120),
  name: globalRow.name,
  ascii_name: globalRow.ascii_name,
  local_name: globalRow.local_name,
  normalized_name: globalRow.normalized_name,
  alternate_names: globalRow.alternate_names || [],
  // Keep external identifiers unique to canonical global rows. Tenant-owned
  // activation copies are linked back through global/master geography ids.
  external_source: null,
  external_code: null,
  country_code: globalRow.country_code,
  country_iso2: globalRow.country_iso2,
  country_iso3: globalRow.country_iso3,
  admin1_code: globalRow.admin1_code,
  admin2_code: globalRow.admin2_code,
  admin3_code: globalRow.admin3_code,
  admin4_code: globalRow.admin4_code,
  administrative_type: globalRow.administrative_type,
  source_administrative_level: globalRow.source_administrative_level,
  latitude: globalRow.latitude,
  longitude: globalRow.longitude,
  centroid_latitude: globalRow.centroid_latitude,
  centroid_longitude: globalRow.centroid_longitude,
  geometry_type: globalRow.geometry_type,
  geojson: globalRow.geojson,
  simplified_geojson: globalRow.simplified_geojson,
  bounds: globalRow.bounds,
  bounds_north: globalRow.bounds_north,
  bounds_south: globalRow.bounds_south,
  bounds_east: globalRow.bounds_east,
  bounds_west: globalRow.bounds_west,
  population: globalRow.population,
  timezone: globalRow.timezone,
  preferred_source: globalRow.preferred_source,
  preferred_external_code: globalRow.preferred_external_code,
  source_modified_at: globalRow.source_modified_at,
  quality_status: globalRow.quality_status,
  is_active: true,
  is_official_source: globalRow.is_official_source,
  is_platform_managed: false,
  is_verified_local_government: globalRow.is_verified_local_government,
  location_status: globalRow.location_status,
  map_source: globalRow.map_source || globalRow.preferred_source,
  metadata: createdBy ? { activatedBy: createdBy } : undefined,
});

const ensureTenantGeographyAssignment = async ({
  tenantId,
  geographyId,
  createdBy,
  transaction,
}) => {
  const existing = await TenantGeographyAssignment.findOne({
    where: {
      tenant_id: tenantId,
      geography_id: geographyId,
    },
    transaction,
  });

  if (existing) {
    await existing.update({
      is_enabled: true,
      created_by_user_id: existing.created_by_user_id || createdBy || null,
      updated_at: new Date(),
    }, { transaction });
    return existing;
  }

  return TenantGeographyAssignment.create({
    id: randomUUID(),
    tenant_id: tenantId,
    geography_id: geographyId,
    is_enabled: true,
    created_by_user_id: createdBy || null,
  }, { transaction });
};

const activateInTransaction = async ({ tenantId, globalRow, createdBy, transaction, memo }) => {
  if (memo.has(String(globalRow.id))) return memo.get(String(globalRow.id));
  let parentTenantRow = null;
  if (globalRow.parent_id) {
    const parentGlobal = await Geography.findOne({
      where: { id: globalRow.parent_id, tenant_id: null, is_active: true },
      transaction,
    });
    if (parentGlobal) {
      parentTenantRow = await activateInTransaction({ tenantId, globalRow: parentGlobal, createdBy, transaction, memo });
    }
  }

  let tenantRow = await Geography.findOne({
    where: {
      tenant_id: tenantId,
      [Op.or]: [{ global_geography_id: globalRow.id }, { master_geography_id: globalRow.id }],
    },
    transaction,
  });
  if (!tenantRow) {
    tenantRow = await Geography.findOne({
      where: {
        tenant_id: tenantId,
        level: globalRow.level,
        parent_id: parentTenantRow?.id || null,
        [Op.or]: [
          { normalized_name: globalRow.normalized_name || null },
          { code: `${globalRow.code}-${String(tenantId).slice(0, 8)}`.slice(0, 120) },
        ],
      },
      transaction,
    });
  }
  if (!tenantRow) {
    tenantRow = await Geography.create(copyGlobalGeography(globalRow, {
      tenantId,
      parentId: parentTenantRow?.id || null,
      createdBy,
    }), { transaction });
  } else if (!tenantRow.global_geography_id || !tenantRow.master_geography_id || tenantRow.parent_id !== (parentTenantRow?.id || null)) {
    await tenantRow.update({
      global_geography_id: tenantRow.global_geography_id || globalRow.id,
      master_geography_id: tenantRow.master_geography_id || globalRow.id,
      parent_id: parentTenantRow?.id || tenantRow.parent_id,
      updated_at: new Date(),
    }, { transaction });
  } else if (tenantRow.global_geography_id !== globalRow.id || tenantRow.master_geography_id !== globalRow.id) {
    await tenantRow.update({
      global_geography_id: globalRow.id,
      master_geography_id: globalRow.id,
      updated_at: new Date(),
    }, { transaction });
  }
  if (!tenantRow) {
    throw new Error(`Unable to activate tenant geography for global geography ${globalRow.id}`);
  }
  await ensureTenantGeographyAssignment({
    tenantId,
    geographyId: globalRow.id,
    createdBy,
    transaction,
  });
  memo.set(String(globalRow.id), tenantRow);
  return tenantRow;
};

const resolveOrCreateTenantGeographyFromGlobal = async ({
  tenantId,
  globalGeographyId,
  createdBy,
  actor,
  transaction: outerTransaction = null,
}) => {
  if (!tenantId || !globalGeographyId) throw new Error('tenantId and globalGeographyId are required');
  assertTenantAuthorization({ actor, tenantId });
  const execute = async (transaction) => {
    const [tenant, globalRow] = await Promise.all([
      Tenant.findByPk(tenantId, { transaction }),
      Geography.findOne({ where: { id: globalGeographyId, tenant_id: null, is_active: true }, transaction }),
    ]);
    if (!tenant) throw new Error('Tenant not found');
    if (!globalRow || !['country', 'state', 'district', 'city'].includes(globalRow.level)) {
      const error = new Error('Global geography is missing, inactive, or not an official level');
      error.status = 400;
      error.code = 'GLOBAL_GEOGRAPHY_INVALID';
      throw error;
    }
    return activateInTransaction({
      tenantId,
      globalRow,
      createdBy,
      transaction,
      memo: new Map(),
    });
  };
  return outerTransaction ? execute(outerTransaction) : sequelize.transaction(execute);
};

module.exports = { copyGlobalGeography, resolveOrCreateTenantGeographyFromGlobal };
