'use strict';

const crypto = require('crypto');

const AUDITOR_ROLE_CODE = 'auditor';
const REQUIRED_AUDITOR_PERMISSION_CODES = [
  'auth.read',
  'dashboard.read',
  'inspection.review',
  'reports.read',
  'audit.read',
];

const ensurePermissionRows = async (queryInterface, permissionCodes, transaction) => {
  const now = new Date();
  const normalizedCodes = [...new Set((permissionCodes || []).map((code) => String(code || '').trim()).filter(Boolean))];

  for (const code of normalizedCodes) {
    await queryInterface.sequelize.query(
      `
      INSERT INTO permissions (id, code, name, description, created_at, updated_at)
      VALUES (:id, :code, :name, :description, :now, :now)
      ON CONFLICT (code)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
      `,
      {
        replacements: {
          id: crypto.randomUUID(),
          code,
          name: code,
          description: code,
          now,
        },
        transaction,
      },
    );
  }
};

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await ensurePermissionRows(
        queryInterface,
        REQUIRED_AUDITOR_PERMISSION_CODES,
        transaction,
      );

      const roleRows = await queryInterface.sequelize.query(
        `SELECT id FROM roles WHERE code = :roleCode LIMIT 1`,
        {
          replacements: { roleCode: AUDITOR_ROLE_CODE },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (!roleRows.length) {
        await transaction.commit();
        return;
      }

      const permissionRows = await queryInterface.sequelize.query(
        `SELECT id, code FROM permissions WHERE code IN (:codes)`,
        {
          replacements: { codes: REQUIRED_AUDITOR_PERMISSION_CODES },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const permissionIdByCode = new Map(
        permissionRows.map((row) => [String(row.code), row.id]),
      );

      const roleId = roleRows[0].id;
      const existingRows = await queryInterface.sequelize.query(
        `
        SELECT permission_id
        FROM role_permissions
        WHERE role_id = :roleId
        `,
        {
          replacements: { roleId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const existingPermissionIds = new Set(
        existingRows.map((row) => String(row.permission_id)),
      );

      const now = new Date();
      const rolePermissionRows = [];
      for (const permissionCode of REQUIRED_AUDITOR_PERMISSION_CODES) {
        const permissionId = permissionIdByCode.get(permissionCode);
        if (!permissionId) continue;
        if (existingPermissionIds.has(String(permissionId))) continue;
        existingPermissionIds.add(String(permissionId));
        rolePermissionRows.push({
          id: crypto.randomUUID(),
          role_id: roleId,
          permission_id: permissionId,
          created_at: now,
          updated_at: now,
        });
      }

      if (rolePermissionRows.length > 0) {
        await queryInterface.bulkInsert('role_permissions', rolePermissionRows, {
          transaction,
        });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down() {
    // Intentionally no-op to avoid removing existing role-permission data.
  },
};
