const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  Tenant,
  Geography,
  Facility,
  ToiletBlock,
  ToiletUnit,
} = require('../../models');
const { createAuditLog } = require('../audit/audit.service');
const { normalizePagination, sanitizeText } = require('../../utils/validators');

const tenantScope = (req, requestedTenantId) => {
  if (req.user.isSuperAdmin) {
    return requestedTenantId || null;
  }
  return req.user.tenantId;
};

const normalizePermanentQrCode = (value) => {
  const text = sanitizeText(value, 180);
  if (!text) return '';
  return text.toUpperCase();
};

const normalizeIdentifierPart = (value, fallback) => {
  const text = sanitizeText(value, 120);
  const normalized = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const buildAutoToiletId = async ({ facility, toiletBlock }) => {
  const facilityPart = normalizeIdentifierPart(
    facility.code || facility.name,
    'FAC'
  );
  const blockPart = normalizeIdentifierPart(toiletBlock.code || toiletBlock.name, 'BLK');
  const prefix = `${facilityPart}-${blockPart}-T`;

  const rows = await ToiletUnit.findAll({
    where: { toilet_block_id: toiletBlock.id },
    attributes: ['code'],
  });

  const usedCodes = new Set(
    rows
      .map((row) => String(row.code || '').toUpperCase())
      .filter(Boolean)
  );

  let sequence = 1;
  while (sequence <= 9999) {
    const candidate = `${prefix}${String(sequence).padStart(3, '0')}`;
    if (!usedCodes.has(candidate)) {
      return candidate;
    }
    sequence += 1;
  }

  throw new AppError('Unable to auto-generate toilet id. Capacity reached for block.', 409, {
    code: 'TOILET_ID_CAPACITY_REACHED',
  });
};

const listTenants = async (req) => {
  const where = {};
  if (!req.user.isSuperAdmin) {
    where.id = req.user.tenantId;
  }
  const tenants = await Tenant.findAll({
    where,
    order: [['name', 'ASC']],
  });
  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    code: tenant.code,
    status: tenant.status,
    countryCode: tenant.country_code,
  }));
};

const createTenant = async (req) => {
  if (!req.user.isSuperAdmin) {
    throw new AppError('Only super admins can create tenants', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  const tenant = await Tenant.create({
    name: sanitizeText(req.body.name, 200),
    code: sanitizeText(req.body.code, 120),
    status: req.body.status || 'active',
    country_code: req.body.countryCode || null,
    metadata: req.body.metadata || null,
  });
  await createAuditLog({
    req,
    action: 'tenant.create',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  return tenant;
};

const patchTenant = async (req) => {
  if (!req.user.isSuperAdmin) {
    throw new AppError('Only super admins can update tenants', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  const tenant = await Tenant.findByPk(req.params.id);
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  await tenant.update({
    name: req.body.name ? sanitizeText(req.body.name, 200) : tenant.name,
    status: req.body.status || tenant.status,
    country_code: req.body.countryCode || tenant.country_code,
    metadata: req.body.metadata ?? tenant.metadata,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'tenant.update',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  return tenant;
};

const buildGeographyTree = (rows) => {
  const map = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots = [];
  for (const row of map.values()) {
    if (row.parentId && map.has(row.parentId)) {
      map.get(row.parentId).children.push(row);
    } else {
      roots.push(row);
    }
  }
  return roots;
};

const listGeographyTree = async (req) => {
  const tenantId = tenantScope(req, req.query.tenantId);
  const where = tenantId ? { tenant_id: tenantId } : {};
  const rows = await Geography.findAll({
    where,
    order: [['level', 'ASC'], ['name', 'ASC']],
  });
  const mapped = rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    tenantId: row.tenant_id,
    level: row.level,
    code: row.code,
    name: row.name,
  }));
  return buildGeographyTree(mapped);
};

const createGeography = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }
  const row = await Geography.create({
    tenant_id: tenantId,
    parent_id: req.body.parentId || null,
    level: req.body.level,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 200),
    centroid_latitude: req.body.centroidLatitude ?? null,
    centroid_longitude: req.body.centroidLongitude ?? null,
  });
  await createAuditLog({
    req,
    action: 'geography.create',
    entityType: 'geography',
    entityId: row.id,
    tenantId,
  });
  return row;
};

const listFacilities = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = {};
  const tenantId = tenantScope(req, req.query.tenantId);
  if (tenantId) {
    where.tenant_id = tenantId;
  }
  if (req.query.geographyId) {
    where.geography_id = req.query.geographyId;
  }
  if (req.query.search) {
    const q = sanitizeText(req.query.search, 120);
    where[Op.or] = [
      { name: { [Op.iLike]: `%${q}%` } },
      { code: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const { rows, count } = await Facility.findAndCountAll({
    where,
    order: [['name', 'ASC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      geographyId: row.geography_id,
      code: row.code,
      name: row.name,
      facilityType: row.facility_type,
      addressLine: row.address_line,
      latitude: row.latitude,
      longitude: row.longitude,
      status: row.status,
      metadata: row.metadata,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createFacility = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }
  const facility = await Facility.create({
    tenant_id: tenantId,
    geography_id: req.body.geographyId || null,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 220),
    facility_type: sanitizeText(req.body.facilityType, 80),
    address_line: req.body.addressLine ? sanitizeText(req.body.addressLine, 300) : null,
    latitude: req.body.latitude ?? null,
    longitude: req.body.longitude ?? null,
    status: req.body.status || 'active',
    metadata: req.body.metadata || null,
  });
  await createAuditLog({
    req,
    action: 'facility.create',
    entityType: 'facility',
    entityId: facility.id,
    tenantId,
  });
  return facility;
};

const patchFacility = async (req) => {
  const facility = await Facility.findByPk(req.params.id);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  await facility.update({
    name: req.body.name ? sanitizeText(req.body.name, 220) : facility.name,
    facility_type: req.body.facilityType || facility.facility_type,
    address_line: req.body.addressLine ?? facility.address_line,
    latitude: req.body.latitude ?? facility.latitude,
    longitude: req.body.longitude ?? facility.longitude,
    status: req.body.status || facility.status,
    metadata: req.body.metadata ?? facility.metadata,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'facility.update',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
  });
  return facility;
};

const getFacilityById = async (req) => {
  const facility = await Facility.findByPk(req.params.id);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const [blocks, units] = await Promise.all([
    ToiletBlock.findAll({ where: { facility_id: facility.id }, order: [['name', 'ASC']] }),
    ToiletUnit.findAll({ where: { facility_id: facility.id }, order: [['code', 'ASC']] }),
  ]);

  return {
    id: facility.id,
    tenantId: facility.tenant_id,
    geographyId: facility.geography_id,
    code: facility.code,
    name: facility.name,
    facilityType: facility.facility_type,
    addressLine: facility.address_line,
    latitude: facility.latitude,
    longitude: facility.longitude,
    status: facility.status,
    metadata: facility.metadata,
    blocks: blocks.map((block) => ({
      id: block.id,
      code: block.code,
      name: block.name,
      genderType: block.gender_type,
      status: block.status,
    })),
    units: units.map((unit) => ({
      id: unit.id,
      code: unit.code,
      qrCode: unit.qr_code || unit.code,
      unitType: unit.unit_type,
      status: unit.status,
      toiletBlockId: unit.toilet_block_id,
    })),
  };
};

const listBlocks = async (req) => {
  const where = {};
  const facilityInclude = {
    model: Facility,
    attributes: ['id', 'tenant_id'],
    required: true,
  };
  if (!req.user.isSuperAdmin) {
    facilityInclude.where = { tenant_id: req.user.tenantId };
  } else if (req.query.tenantId) {
    facilityInclude.where = { tenant_id: req.query.tenantId };
  }
  if (req.query.facilityId) {
    where.facility_id = req.query.facilityId;
  }
  const rows = await ToiletBlock.findAll({
    where,
    include: [facilityInclude],
    order: [['name', 'ASC']],
  });
  return rows.map((row) => ({
    id: row.id,
    facilityId: row.facility_id,
    code: row.code,
    name: row.name,
    genderType: row.gender_type,
    status: row.status,
  }));
};

const createBlock = async (req) => {
  const facility = await Facility.findByPk(req.body.facilityId);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const row = await ToiletBlock.create({
    facility_id: facility.id,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 200),
    gender_type: req.body.genderType || null,
    status: req.body.status || 'active',
  });
  await createAuditLog({
    req,
    action: 'toilet_block.create',
    entityType: 'toilet_block',
    entityId: row.id,
    tenantId: facility.tenant_id,
  });
  return row;
};

const listUnits = async (req) => {
  const where = {};
  const facilityInclude = {
    model: Facility,
    attributes: ['id', 'tenant_id', 'code', 'name'],
    required: true,
  };
  if (!req.user.isSuperAdmin) {
    facilityInclude.where = { tenant_id: req.user.tenantId };
  } else if (req.query.tenantId) {
    facilityInclude.where = { tenant_id: req.query.tenantId };
  }
  if (req.query.facilityId) {
    where.facility_id = req.query.facilityId;
  }
  if (req.query.toiletBlockId) {
    where.toilet_block_id = req.query.toiletBlockId;
  }
  if (req.query.qrCode) {
    const qrCode = normalizePermanentQrCode(req.query.qrCode);
    where[Op.or] = [
      { qr_code: { [Op.iLike]: qrCode } },
      { code: { [Op.iLike]: qrCode } },
    ];
  }
  const rows = await ToiletUnit.findAll({
    where,
    include: [facilityInclude],
    order: [['code', 'ASC']],
  });
  return rows.map((row) => ({
    id: row.id,
    facilityId: row.facility_id,
    facilityCode: row.Facility?.code || null,
    facilityName: row.Facility?.name || null,
    toiletBlockId: row.toilet_block_id,
    code: row.code,
    qrCode: row.qr_code || row.code,
    unitType: row.unit_type,
    status: row.status,
  }));
};

const createUnit = async (req) => {
  const facility = await Facility.findByPk(req.body.facilityId);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const requestedCode = sanitizeText(req.body.code, 120);
  const unitType = sanitizeText(req.body.unitType, 40);

  const toiletBlock = await ToiletBlock.findByPk(req.body.toiletBlockId, {
    attributes: ['id', 'facility_id'],
  });
  if (!toiletBlock) {
    throw new AppError('Toilet block not found', 404, { code: 'TOILET_BLOCK_NOT_FOUND' });
  }
  if (toiletBlock.facility_id !== facility.id) {
    throw new AppError('toiletBlockId does not belong to facilityId', 400, {
      code: 'BLOCK_FACILITY_MISMATCH',
    });
  }

  const unitCode = requestedCode
    ? requestedCode.toUpperCase()
    : await buildAutoToiletId({ facility, toiletBlock });

  const qrCode = normalizePermanentQrCode(
    req.body.permanentQrCode || req.body.qrCode || unitCode
  );

  const duplicateCode = await ToiletUnit.findOne({
    where: {
      facility_id: facility.id,
      code: unitCode,
    },
    attributes: ['id'],
  });
  if (duplicateCode) {
    throw new AppError('Toilet unit code already exists in this facility', 409, {
      code: 'TOILET_UNIT_CODE_EXISTS',
    });
  }

  const duplicateQr = await ToiletUnit.findOne({
    where: { qr_code: qrCode },
    attributes: ['id'],
  });
  if (duplicateQr) {
    throw new AppError('permanentQrCode already exists', 409, { code: 'QR_CODE_EXISTS' });
  }

  const row = await ToiletUnit.create({
    facility_id: facility.id,
    toilet_block_id: toiletBlock.id,
    code: unitCode,
    qr_code: qrCode,
    unit_type: unitType,
    status: req.body.status || 'moderate',
  });
  await createAuditLog({
    req,
    action: 'toilet_unit.create',
    entityType: 'toilet_unit',
    entityId: row.id,
    tenantId: facility.tenant_id,
  });
  return {
    id: row.id,
    facilityId: row.facility_id,
    toiletBlockId: row.toilet_block_id,
    code: row.code,
    qrCode: row.qr_code || row.code,
    unitType: row.unit_type,
    status: row.status,
  };
};

module.exports = {
  listTenants,
  createTenant,
  patchTenant,
  listGeographyTree,
  createGeography,
  listFacilities,
  createFacility,
  patchFacility,
  getFacilityById,
  listBlocks,
  createBlock,
  listUnits,
  createUnit,
};
