const crypto = require('crypto');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const { OperationalMasterData, Tenant, Geography } = require('../../models');
const { createAuditLog } = require('../audit/audit.service');
const { normalizePagination, sanitizeText } = require('../../utils/validators');

const MASTER_TYPE_LABELS = {
  overview: 'Overview',
  facility_type: 'Facility Types',
  asset_fixture_catalogue: 'Asset & Fixture Catalogue',
  checklist_template: 'Checklist Templates',
  issue_category: 'Issue Categories',
  standards_sla: 'Standards & SLA',
  task_shift_template: 'Task / Shift Templates',
};

const FILTERABLE_MASTER_TYPES = Object.keys(MASTER_TYPE_LABELS).filter((key) => key !== 'overview');

const ROLE_CODES = {
  SUPER_ADMIN: 'super_admin',
  STATE_ADMIN: 'state_admin',
  TENANT_ADMIN: 'tenant_admin',
};

const SOURCE_SCOPE = {
  PLATFORM: 'PLATFORM',
  STATE: 'STATE',
  TENANT: 'TENANT',
};

const STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
};

const isRole = (req, roleCode) => (req?.user?.roleCodes || []).includes(roleCode);

const getActorMode = (req) => {
  if (req?.user?.isSuperAdmin || isRole(req, ROLE_CODES.SUPER_ADMIN)) return ROLE_CODES.SUPER_ADMIN;
  if (isRole(req, ROLE_CODES.STATE_ADMIN)) return ROLE_CODES.STATE_ADMIN;
  if (isRole(req, ROLE_CODES.TENANT_ADMIN)) return ROLE_CODES.TENANT_ADMIN;
  throw new AppError('Operational master data is not available for this role', 403, {
    code: 'OPERATIONAL_MASTER_DATA_FORBIDDEN',
  });
};

const findStateAncestorId = async (geographyId) => {
  let currentId = geographyId || null;
  const seen = new Set();
  while (currentId && !seen.has(String(currentId))) {
    seen.add(String(currentId));
    const row = await Geography.findByPk(currentId, { attributes: ['id', 'level', 'parent_id'] });
    if (!row) break;
    if (String(row.level || '').toLowerCase() === 'state') return row.id;
    currentId = row.parent_id || null;
  }
  return null;
};

const resolveStateScopeId = async (req) => {
  if (req?.user?.isSuperAdmin) {
    const explicit = String(req.query?.stateId || req.body?.stateId || '').trim();
    return explicit || null;
  }

  const scopedStateIds = (req?.user?.scopeGeographyIds || [])
    .concat([req?.user?.scopeId, req?.user?.geographyId])
    .filter(Boolean);

  for (const geographyId of scopedStateIds) {
    const stateId = await findStateAncestorId(geographyId);
    if (stateId) return stateId;
  }

  if (isRole(req, ROLE_CODES.TENANT_ADMIN) && req?.user?.tenantId) {
    const tenant = await Tenant.findByPk(req.user.tenantId, { attributes: ['root_geography_id'] });
    if (tenant?.root_geography_id) {
      return findStateAncestorId(tenant.root_geography_id);
    }
  }

  return null;
};

const normalizeMasterType = (value) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^\w]+/g, '_');
  return FILTERABLE_MASTER_TYPES.includes(normalized) ? normalized : null;
};

const normalizeRow = (row, actorMode) => {
  const sourceScope = row.source_scope;
  const inherited = actorMode === ROLE_CODES.TENANT_ADMIN
    ? sourceScope !== SOURCE_SCOPE.TENANT
    : actorMode === ROLE_CODES.STATE_ADMIN
      ? sourceScope === SOURCE_SCOPE.PLATFORM
      : false;
  const canOverride = actorMode === ROLE_CODES.TENANT_ADMIN && inherited && Boolean(row.allow_tenant_override);
  const locked = inherited && (!canOverride || Boolean(row.is_mandatory));

  return {
    id: row.id,
    masterType: row.master_type,
    code: row.code,
    name: row.name,
    description: row.description || '',
    status: row.status,
    sourceScope: sourceScope,
    stateId: row.state_id || null,
    tenantId: row.tenant_id || null,
    isMandatory: Boolean(row.is_mandatory),
    allowTenantOverride: Boolean(row.allow_tenant_override),
    parentId: row.parent_id || null,
    sortOrder: Number(row.sort_order || 0),
    metadata: row.metadata || {},
    createdBy: row.created_by_user_id || null,
    updatedBy: row.updated_by_user_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    inherited,
    locked,
    canEdit: actorMode === ROLE_CODES.SUPER_ADMIN
      ? true
      : actorMode === ROLE_CODES.STATE_ADMIN
        ? sourceScope === SOURCE_SCOPE.STATE
        : sourceScope === SOURCE_SCOPE.TENANT,
    canOverride,
  };
};

const buildVisibilityWhere = ({ actorMode, stateId, tenantId }) => {
  if (actorMode === ROLE_CODES.SUPER_ADMIN) {
    return {};
  }
  if (actorMode === ROLE_CODES.STATE_ADMIN) {
    return {
      [Op.or]: [
        { source_scope: SOURCE_SCOPE.PLATFORM },
        { source_scope: SOURCE_SCOPE.STATE, state_id: stateId || null },
      ],
    };
  }
  return {
    [Op.or]: [
      { source_scope: SOURCE_SCOPE.PLATFORM },
      { source_scope: SOURCE_SCOPE.STATE, state_id: stateId || null },
      { source_scope: SOURCE_SCOPE.TENANT, tenant_id: tenantId || null },
    ],
  };
};

const assertNoDuplicateCode = async ({
  masterType,
  code,
  sourceScope,
  stateId = null,
  tenantId = null,
  excludeId = null,
}) => {
  const where = {
    master_type: masterType,
    source_scope: sourceScope,
    state_id: stateId || null,
    tenant_id: tenantId || null,
    code: { [Op.iLike]: sanitizeText(code, 120) },
  };
  if (excludeId) {
    where.id = { [Op.ne]: excludeId };
  }
  const existing = await OperationalMasterData.findOne({ where, attributes: ['id'] });
  if (existing) {
    throw new AppError('A record with this code already exists in the current scope', 409, {
      code: 'OPERATIONAL_MASTER_DATA_DUPLICATE_CODE',
    });
  }
};

const getRecordOrThrow = async (id) => {
  const row = await OperationalMasterData.findByPk(id);
  if (!row) {
    throw new AppError('Operational master data record not found', 404, {
      code: 'OPERATIONAL_MASTER_DATA_NOT_FOUND',
    });
  }
  return row;
};

const assertCanMutateRecord = async ({ req, row, actorMode, stateId }) => {
  if (actorMode === ROLE_CODES.SUPER_ADMIN) return;
  if (actorMode === ROLE_CODES.STATE_ADMIN) {
    if (row.source_scope !== SOURCE_SCOPE.STATE || String(row.state_id || '') !== String(stateId || '')) {
      throw new AppError('State admin cannot modify inherited or out-of-scope records', 403, {
        code: 'OPERATIONAL_MASTER_DATA_STATE_READ_ONLY',
      });
    }
    return;
  }
  if (row.source_scope !== SOURCE_SCOPE.TENANT || String(row.tenant_id || '') !== String(req.user.tenantId || '')) {
    throw new AppError('Tenant admin cannot modify inherited records', 403, {
      code: 'OPERATIONAL_MASTER_DATA_TENANT_READ_ONLY',
    });
  }
};

const assertTenantOverrideAllowed = async ({ req, actorMode, parentId, stateId }) => {
  if (!parentId || actorMode !== ROLE_CODES.TENANT_ADMIN) return;
  const parent = await getRecordOrThrow(parentId);
  const visibleToTenant =
    parent.source_scope === SOURCE_SCOPE.PLATFORM ||
    (parent.source_scope === SOURCE_SCOPE.STATE && String(parent.state_id || '') === String(stateId || '')) ||
    (parent.source_scope === SOURCE_SCOPE.TENANT && String(parent.tenant_id || '') === String(req.user.tenantId || ''));
  if (!visibleToTenant) {
    throw new AppError('Override source record is outside tenant scope', 403, {
      code: 'OPERATIONAL_MASTER_DATA_OVERRIDE_SCOPE_FORBIDDEN',
    });
  }
  if (parent.source_scope !== SOURCE_SCOPE.TENANT && !parent.allow_tenant_override) {
    throw new AppError('This inherited record does not allow tenant override', 403, {
      code: 'OPERATIONAL_MASTER_DATA_OVERRIDE_FORBIDDEN',
    });
  }
};

const listOperationalMasterData = async (req) => {
  const actorMode = getActorMode(req);
  const stateId = await resolveStateScopeId(req);
  const tenantId = req.user?.tenantId || null;
  const { page, limit } = normalizePagination(req.query, { page: 1, limit: 10, maxLimit: 100 });
  const search = sanitizeText(req.query.search, 120);
  const masterType = normalizeMasterType(req.query.masterType);
  const sourceFilter = String(req.query.sourceScope || '').trim().toUpperCase();
  const statusFilter = String(req.query.status || '').trim().toLowerCase();

  const where = buildVisibilityWhere({ actorMode, stateId, tenantId });
  if (masterType) where.master_type = masterType;
  if ([SOURCE_SCOPE.PLATFORM, SOURCE_SCOPE.STATE, SOURCE_SCOPE.TENANT].includes(sourceFilter)) {
    where.source_scope = sourceFilter;
  }
  if ([STATUS.ACTIVE, STATUS.INACTIVE].includes(statusFilter)) {
    where.status = statusFilter;
  }
  if (search) {
    where[Op.and] = [
      ...(Array.isArray(where[Op.and]) ? where[Op.and] : []),
      {
        [Op.or]: [
          { code: { [Op.iLike]: `%${search}%` } },
          { name: { [Op.iLike]: `%${search}%` } },
          { description: { [Op.iLike]: `%${search}%` } },
        ],
      },
    ];
  }

  const rows = await OperationalMasterData.findAll({
    where,
    order: [['sort_order', 'ASC'], ['updated_at', 'DESC'], ['name', 'ASC']],
  });

  const items = rows.map((row) => normalizeRow(row, actorMode));
  const total = items.length;
  const offset = (page - 1) * limit;
  const pageItems = items.slice(offset, offset + limit);

  const activeCount = items.filter((item) => item.status === STATUS.ACTIVE).length;
  const inheritedCount = items.filter((item) => item.inherited).length;
  const localCount = items.length - inheritedCount;
  const byType = FILTERABLE_MASTER_TYPES.reduce((acc, key) => {
    acc[key] = items.filter((item) => item.masterType === key).length;
    return acc;
  }, {});
  const mostUsedChecklistTemplates = items
    .filter((item) => item.masterType === 'checklist_template')
    .sort((left, right) => Number(right.metadata?.usageCount || 0) - Number(left.metadata?.usageCount || 0))
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      name: item.name,
      usageCount: Number(item.metadata?.usageCount || 0),
      sourceScope: item.sourceScope,
    }));
  const recentModified = items
    .slice()
    .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
    .slice(0, 6);
  const mandatoryTypes = ['facility_type', 'asset_fixture_catalogue', 'checklist_template', 'issue_category', 'standards_sla'];
  const configuredTypes = new Set(items.filter((item) => item.status === STATUS.ACTIVE).map((item) => item.masterType));
  const needsConfiguration = mandatoryTypes
    .filter((key) => !configuredTypes.has(key))
    .map((key) => ({ masterType: key, label: MASTER_TYPE_LABELS[key] }));

  return {
    items: pageItems,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    summary: {
      countsByType: byType,
      totalRecords: items.length,
      activeCount,
      inactiveCount: items.length - activeCount,
      inheritedCount,
      localCount,
      completenessPercent: mandatoryTypes.length === 0 ? 100 : Math.round((configuredTypes.size / mandatoryTypes.length) * 100),
      mostUsedChecklistTemplates,
      recentModified,
      needsConfiguration,
    },
  };
};

const createOperationalMasterData = async (req) => {
  const actorMode = getActorMode(req);
  const stateId = await resolveStateScopeId(req);
  const masterType = normalizeMasterType(req.body?.masterType);
  if (!masterType) {
    throw new AppError('A valid masterType is required', 400, { code: 'OPERATIONAL_MASTER_DATA_MASTER_TYPE_REQUIRED' });
  }
  const code = sanitizeText(req.body?.code, 120);
  const name = sanitizeText(req.body?.name, 200);
  if (!code || !name) {
    throw new AppError('Code and name are required', 400, { code: 'OPERATIONAL_MASTER_DATA_NAME_CODE_REQUIRED' });
  }

  const parentId = String(req.body?.parentId || '').trim() || null;
  await assertTenantOverrideAllowed({ req, actorMode, parentId, stateId });

  const sourceScope = actorMode === ROLE_CODES.SUPER_ADMIN
    ? SOURCE_SCOPE.PLATFORM
    : actorMode === ROLE_CODES.STATE_ADMIN
      ? SOURCE_SCOPE.STATE
      : SOURCE_SCOPE.TENANT;
  const tenantId = sourceScope === SOURCE_SCOPE.TENANT ? req.user.tenantId : null;
  const resolvedStateId = sourceScope === SOURCE_SCOPE.STATE || sourceScope === SOURCE_SCOPE.TENANT ? stateId : null;

  await assertNoDuplicateCode({
    masterType,
    code,
    sourceScope,
    stateId: resolvedStateId,
    tenantId,
  });

  const row = await OperationalMasterData.create({
    id: crypto.randomUUID(),
    master_type: masterType,
    code,
    name,
    description: sanitizeText(req.body?.description, 600) || null,
    status: String(req.body?.status || STATUS.ACTIVE).trim().toLowerCase() === STATUS.INACTIVE ? STATUS.INACTIVE : STATUS.ACTIVE,
    source_scope: sourceScope,
    state_id: resolvedStateId,
    tenant_id: tenantId,
    is_mandatory: actorMode === ROLE_CODES.TENANT_ADMIN ? false : Boolean(req.body?.isMandatory),
    allow_tenant_override: Boolean(req.body?.allowTenantOverride),
    parent_id: parentId,
    sort_order: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 0,
    metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {},
    created_by_user_id: req.user?.id || null,
    updated_by_user_id: req.user?.id || null,
  });

  await createAuditLog({
    req,
    tenantId: row.tenant_id || req.user?.tenantId || null,
    action: 'operational_master_data.create',
    entityType: 'operational_master_data',
    entityId: row.id,
    details: { masterType, sourceScope: row.source_scope, code: row.code, name: row.name },
  });

  return normalizeRow(row, actorMode);
};

const updateOperationalMasterData = async (req) => {
  const actorMode = getActorMode(req);
  const stateId = await resolveStateScopeId(req);
  const row = await getRecordOrThrow(req.params.id);
  await assertCanMutateRecord({ req, row, actorMode, stateId });

  const masterType = normalizeMasterType(req.body?.masterType || row.master_type) || row.master_type;
  const code = sanitizeText(req.body?.code ?? row.code, 120);
  const name = sanitizeText(req.body?.name ?? row.name, 200);
  if (!code || !name) {
    throw new AppError('Code and name are required', 400, { code: 'OPERATIONAL_MASTER_DATA_NAME_CODE_REQUIRED' });
  }

  await assertNoDuplicateCode({
    masterType,
    code,
    sourceScope: row.source_scope,
    stateId: row.state_id || null,
    tenantId: row.tenant_id || null,
    excludeId: row.id,
  });

  await row.update({
    master_type: masterType,
    code,
    name,
    description: sanitizeText(req.body?.description ?? row.description, 600) || null,
    status: String(req.body?.status || row.status).trim().toLowerCase() === STATUS.INACTIVE ? STATUS.INACTIVE : STATUS.ACTIVE,
    is_mandatory: actorMode === ROLE_CODES.TENANT_ADMIN ? row.is_mandatory : Boolean(req.body?.isMandatory ?? row.is_mandatory),
    allow_tenant_override: Boolean(req.body?.allowTenantOverride ?? row.allow_tenant_override),
    sort_order: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : Number(row.sort_order || 0),
    metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : row.metadata,
    updated_by_user_id: req.user?.id || null,
  });

  await createAuditLog({
    req,
    tenantId: row.tenant_id || req.user?.tenantId || null,
    action: 'operational_master_data.update',
    entityType: 'operational_master_data',
    entityId: row.id,
    details: { masterType: row.master_type, sourceScope: row.source_scope, code: row.code, name: row.name },
  });

  return normalizeRow(row, actorMode);
};

const updateOperationalMasterDataStatus = async (req, nextStatus) => {
  const actorMode = getActorMode(req);
  const stateId = await resolveStateScopeId(req);
  const row = await getRecordOrThrow(req.params.id);
  await assertCanMutateRecord({ req, row, actorMode, stateId });
  await row.update({
    status: nextStatus,
    updated_by_user_id: req.user?.id || null,
  });

  await createAuditLog({
    req,
    tenantId: row.tenant_id || req.user?.tenantId || null,
    action: nextStatus === STATUS.ACTIVE ? 'operational_master_data.activate' : 'operational_master_data.deactivate',
    entityType: 'operational_master_data',
    entityId: row.id,
    details: { masterType: row.master_type, sourceScope: row.source_scope, code: row.code, status: nextStatus },
  });

  return normalizeRow(row, actorMode);
};

module.exports = {
  MASTER_TYPE_LABELS,
  FILTERABLE_MASTER_TYPES,
  SOURCE_SCOPE,
  STATUS,
  getActorMode,
  resolveStateScopeId,
  normalizeMasterType,
  listOperationalMasterData,
  createOperationalMasterData,
  updateOperationalMasterData,
  activateOperationalMasterData: (req) => updateOperationalMasterDataStatus(req, STATUS.ACTIVE),
  deactivateOperationalMasterData: (req) => updateOperationalMasterDataStatus(req, STATUS.INACTIVE),
};
