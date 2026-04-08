/* eslint-disable no-console */
require('dotenv').config();

const crypto = require('crypto');
const { sequelize, Role, Permission, RolePermission } = require('../src/models');
const { ROLE_PERMISSION_BUNDLES } = require('../src/core/rbac/defaultRoleBundles');

async function ensurePermissions(permissionCodes, transaction) {
  const uniqueCodes = [...new Set((permissionCodes || []).map((code) => String(code || '').trim()).filter(Boolean))];
  if (uniqueCodes.length === 0) return [];

  const existing = await Permission.findAll({
    where: { code: uniqueCodes },
    attributes: ['id', 'code'],
    transaction,
  });
  const existingByCode = new Map(existing.map((row) => [row.code, row.id]));

  const missingCodes = uniqueCodes.filter((code) => !existingByCode.has(code));
  if (missingCodes.length > 0) {
    const now = new Date();
    const rows = missingCodes.map((code) => ({
      id: crypto.randomUUID(),
      code,
      name: code,
      description: code,
      created_at: now,
      updated_at: now,
    }));
    await Permission.bulkCreate(rows, { transaction });
  }

  return Permission.findAll({
    where: { code: uniqueCodes },
    attributes: ['id', 'code'],
    transaction,
  });
}

async function syncRolePermissions() {
  const transaction = await sequelize.transaction();
  try {
    const roleCodes = Object.keys(ROLE_PERMISSION_BUNDLES);
    const roles = await Role.findAll({
      where: { code: roleCodes },
      attributes: ['id', 'code'],
      transaction,
    });
    const rolesByCode = new Map(roles.map((row) => [row.code, row.id]));

    const allPermissionCodes = Object.values(ROLE_PERMISSION_BUNDLES).flat();
    const permissions = await ensurePermissions(allPermissionCodes, transaction);
    const permissionsByCode = new Map(permissions.map((row) => [row.code, row.id]));

    const existingRolePermissions = await RolePermission.findAll({
      attributes: ['role_id', 'permission_id'],
      transaction,
    });
    const existingPairs = new Set(
      existingRolePermissions.map((row) => `${row.role_id}:${row.permission_id}`),
    );

    const rowsToInsert = [];
    const missingSummary = [];

    for (const [roleCode, permissionCodes] of Object.entries(ROLE_PERMISSION_BUNDLES)) {
      const roleId = rolesByCode.get(roleCode);
      if (!roleId) {
        missingSummary.push({ roleCode, added: 0, missingRole: true });
        continue;
      }

      let addedForRole = 0;
      for (const permissionCode of permissionCodes) {
        const permissionId = permissionsByCode.get(permissionCode);
        if (!permissionId) continue;
        const pairKey = `${roleId}:${permissionId}`;
        if (existingPairs.has(pairKey)) continue;
        existingPairs.add(pairKey);
        addedForRole += 1;
        rowsToInsert.push({
          id: crypto.randomUUID(),
          role_id: roleId,
          permission_id: permissionId,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }

      missingSummary.push({ roleCode, added: addedForRole, missingRole: false });
    }

    if (rowsToInsert.length > 0) {
      await RolePermission.bulkCreate(rowsToInsert, { transaction });
    }

    await transaction.commit();

    console.log(`RBAC sync completed. Added ${rowsToInsert.length} missing role-permission mappings.`);
    for (const row of missingSummary) {
      if (row.missingRole) {
        console.log(`- ${row.roleCode}: skipped (role not found)`);
      } else if (row.added > 0) {
        console.log(`- ${row.roleCode}: added ${row.added}`);
      }
    }
  } catch (error) {
    await transaction.rollback();
    console.error('RBAC sync failed:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

syncRolePermissions();
