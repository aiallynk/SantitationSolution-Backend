'use strict';

const { DataTypes } = require('sequelize');

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const description = await queryInterface.describeTable(table);
  if (!description[column]) {
    await queryInterface.addColumn(table, column, spec);
  }
};

const removeColumnIfExists = async (queryInterface, table, column) => {
  const description = await queryInterface.describeTable(table);
  if (description[column]) {
    await queryInterface.removeColumn(table, column);
  }
};

const addIndexSafe = async (queryInterface, table, fields, name) => {
  try {
    await queryInterface.addIndex(table, fields, { name });
  } catch (_) {
    // no-op when already exists
  }
};

const removeIndexSafe = async (queryInterface, table, name) => {
  try {
    await queryInterface.removeIndex(table, name);
  } catch (_) {
    // no-op when missing
  }
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'complaints', 'source_channel', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'field_app',
    });
    await addColumnIfMissing(queryInterface, 'complaints', 'reporter_name', {
      type: DataTypes.STRING(180),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'complaints', 'reporter_contact', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'complaints', 'evidence_image_url', {
      type: DataTypes.STRING(500),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'complaints', 'dispatch_requested_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'complaints', 'dispatch_requested_by_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    await addIndexSafe(
      queryInterface,
      'complaints',
      ['tenant_id', 'source_channel', 'status'],
      'complaints_tenant_source_status_idx'
    );
    await addIndexSafe(
      queryInterface,
      'complaints',
      ['tenant_id', 'dispatch_requested_at'],
      'complaints_tenant_dispatch_at_idx'
    );
  },

  async down(queryInterface) {
    await removeIndexSafe(
      queryInterface,
      'complaints',
      'complaints_tenant_dispatch_at_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'complaints',
      'complaints_tenant_source_status_idx'
    );

    await removeColumnIfExists(
      queryInterface,
      'complaints',
      'dispatch_requested_by_user_id'
    );
    await removeColumnIfExists(queryInterface, 'complaints', 'dispatch_requested_at');
    await removeColumnIfExists(queryInterface, 'complaints', 'evidence_image_url');
    await removeColumnIfExists(queryInterface, 'complaints', 'reporter_contact');
    await removeColumnIfExists(queryInterface, 'complaints', 'reporter_name');
    await removeColumnIfExists(queryInterface, 'complaints', 'source_channel');
  },
};

