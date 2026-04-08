#!/usr/bin/env node
require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { sequelize, Tenant, Geography, Facility, PlatformUser, Role, UserRole, WorkerAssignment } = require('../src/models');

const DEFAULT_PASSWORD = String(process.env.PERSONA_SEED_PASSWORD || '11111111');

const PERSONA_SPECS = [
  {
    email: 'org.ops.admin@demo.ai',
    fullName: 'Org Ops Admin',
    employeeCode: 'OPS-ORG-001',
    roleCode: 'tenant_admin',
    scopeLevel: 'organization',
  },
  {
    email: 'country.ops.admin@demo.ai',
    fullName: 'Country Ops Admin',
    employeeCode: 'OPS-CTR-001',
    roleCode: 'country_admin',
    scopeLevel: 'country',
  },
  {
    email: 'state.ops.admin@demo.ai',
    fullName: 'State Ops Admin',
    employeeCode: 'OPS-STA-001',
    roleCode: 'state_admin',
    scopeLevel: 'state',
  },
  {
    email: 'district.ops.admin@demo.ai',
    fullName: 'District Ops Admin',
    employeeCode: 'OPS-DIS-001',
    roleCode: 'district_admin',
    scopeLevel: 'district',
  },
  {
    email: 'city.ops.admin@demo.ai',
    fullName: 'City Ops Admin',
    employeeCode: 'OPS-CIT-001',
    roleCode: 'city_admin',
    scopeLevel: 'city',
  },
  {
    email: 'zone.ops.admin@demo.ai',
    fullName: 'Zone Ops Admin',
    employeeCode: 'OPS-ZON-001',
    roleCode: 'zone_admin',
    scopeLevel: 'zone',
  },
  {
    email: 'facility.ops.admin@demo.ai',
    fullName: 'Facility Ops Admin',
    employeeCode: 'OPS-FAC-001',
    roleCode: 'facility_manager',
    scopeLevel: 'facility',
  },
  {
    email: 'supervisor@demo.ai',
    fullName: 'Operations Supervisor',
    employeeCode: 'SUP-001',
    roleCode: 'supervisor',
    scopeLevel: 'facility',
  },
  {
    email: 'viewer@demo.ai',
    fullName: 'Operations Viewer',
    employeeCode: 'VIEW-001',
    roleCode: 'viewer',
    scopeLevel: 'facility',
  },
  {
    email: 'auditor@demo.ai',
    fullName: 'Operations Auditor',
    employeeCode: 'AUD-001',
    roleCode: 'auditor',
    scopeLevel: 'facility',
  },
  {
    email: 'field.worker@demo.ai',
    fullName: 'Field Worker',
    employeeCode: 'FW-001',
    roleCode: 'field_worker',
    scopeLevel: 'facility',
  },
];

const GEO_LEVEL_ORDER = ['country', 'state', 'district', 'city', 'zone'];

const pickGeographyByLevel = (geographiesByLevel, level, fallback = null) => {
  if (level && geographiesByLevel.get(level)?.length > 0) {
    return geographiesByLevel.get(level)[0];
  }
  for (const candidateLevel of GEO_LEVEL_ORDER) {
    if (geographiesByLevel.get(candidateLevel)?.length > 0) {
      return geographiesByLevel.get(candidateLevel)[0];
    }
  }
  return fallback;
};

const ensureRoleMap = async () => {
  const rows = await Role.findAll({
    attributes: ['id', 'code'],
    raw: true,
  });
  return new Map(rows.map((row) => [String(row.code || '').trim().toLowerCase(), row.id]));
};

const ensureTenant = async () => {
  const tenant = await Tenant.findOne({
    where: { status: 'active' },
    order: [['created_at', 'ASC']],
  });
  if (!tenant) {
    throw new Error('No active tenant found. Seed base data before running persona seed.');
  }
  return tenant;
};

const ensureGeographyIndex = async (tenantId) => {
  const rows = await Geography.findAll({
    where: { tenant_id: tenantId },
    attributes: ['id', 'level'],
    order: [['created_at', 'ASC']],
    raw: true,
  });
  const byLevel = new Map();
  for (const row of rows) {
    const level = String(row.level || '').trim().toLowerCase();
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(row.id);
  }
  return byLevel;
};

const ensureFacility = async (tenantId) => {
  const facility = await Facility.findOne({
    where: { tenant_id: tenantId },
    order: [['created_at', 'ASC']],
  });
  if (!facility) {
    throw new Error('No facility found in tenant scope. Create at least one facility before seeding personas.');
  }
  return facility;
};

const upsertPersonaUser = async ({
  spec,
  tenant,
  roleId,
  geographyId,
  facility,
  passwordHash,
}) => {
  const email = String(spec.email || '').trim().toLowerCase();
  const now = new Date();
  const userBasePayload = {
    tenant_id: tenant.id,
    geography_id: geographyId || facility.geography_id || null,
    full_name: spec.fullName,
    email,
    employee_code: spec.employeeCode || null,
    phone: null,
    password_hash: passwordHash,
    auth_provider: 'local',
    status: 'active',
    updated_at: now,
  };

  let user = await PlatformUser.findOne({ where: { email } });
  if (!user) {
    user = await PlatformUser.create({
      id: crypto.randomUUID(),
      ...userBasePayload,
      created_at: now,
    });
  } else {
    await user.update(userBasePayload);
  }

  await UserRole.destroy({ where: { user_id: user.id } });
  await UserRole.create({
    id: crypto.randomUUID(),
    user_id: user.id,
    role_id: roleId,
    tenant_id: tenant.id,
    geography_id: geographyId || facility.geography_id || null,
    created_at: now,
    updated_at: now,
  });

  await WorkerAssignment.destroy({ where: { user_id: user.id } });
  if (spec.scopeLevel !== 'organization') {
    const assignmentLevel = spec.scopeLevel === 'facility' ? 'facility' : 'geography';
    await WorkerAssignment.create({
      id: crypto.randomUUID(),
      tenant_id: tenant.id,
      user_id: user.id,
      geography_id: assignmentLevel === 'facility' ? facility.geography_id || geographyId || null : geographyId,
      facility_id: assignmentLevel === 'facility' ? facility.id : null,
      toilet_unit_id: null,
      assignment_level: assignmentLevel,
      assignment_role: spec.roleCode,
      status: 'active',
      created_by_user_id: null,
      updated_by_user_id: null,
      created_at: now,
      updated_at: now,
    });
  }

  return {
    email,
    roleCode: spec.roleCode,
    scopeLevel: spec.scopeLevel,
    geographyId: geographyId || null,
    facilityId: spec.scopeLevel === 'facility' ? facility.id : null,
  };
};

const run = async () => {
  await sequelize.authenticate();
  const tenant = await ensureTenant();
  const roleMap = await ensureRoleMap();
  const geographiesByLevel = await ensureGeographyIndex(tenant.id);
  const fallbackGeography = pickGeographyByLevel(geographiesByLevel, null, null);
  const facility = await ensureFacility(tenant.id);
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  const seeded = [];
  for (const spec of PERSONA_SPECS) {
    const roleCode = String(spec.roleCode || '').trim().toLowerCase();
    const roleId = roleMap.get(roleCode);
    if (!roleId) {
      // Keep script resilient to partially-seeded RBAC environments.
      // eslint-disable-next-line no-console
      console.warn(`[seed-persona-users] skipping ${spec.email}; role "${roleCode}" not found.`);
      continue;
    }

    const geographyId =
      spec.scopeLevel && spec.scopeLevel !== 'organization' && spec.scopeLevel !== 'facility'
        ? pickGeographyByLevel(geographiesByLevel, spec.scopeLevel, fallbackGeography)
        : fallbackGeography;

    const row = await upsertPersonaUser({
      spec,
      tenant,
      roleId,
      geographyId,
      facility,
      passwordHash,
    });
    seeded.push(row);
  }

  // eslint-disable-next-line no-console
  console.log('[seed-persona-users] completed');
  // eslint-disable-next-line no-console
  console.table(
    seeded.map((row) => ({
      email: row.email,
      password: DEFAULT_PASSWORD,
      roleCode: row.roleCode,
      scopeLevel: row.scopeLevel,
      geographyId: row.geographyId || '-',
      facilityId: row.facilityId || '-',
    }))
  );
};

run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[seed-persona-users] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (_) {
      // ignore close failures
    }
  });
