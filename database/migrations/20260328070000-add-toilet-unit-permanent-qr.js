'use strict';

const { DataTypes, Sequelize } = require('sequelize');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('toilet_units', 'qr_code', {
      type: DataTypes.STRING(180),
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE toilet_units AS tu
      SET qr_code = UPPER(
        COALESCE(f.code, 'FAC') || '-' ||
        COALESCE(tb.code, 'BLK') || '-' ||
        COALESCE(tu.code, REPLACE(tu.id::text, '-', ''))
      )
      FROM toilet_blocks AS tb, facilities AS f
      WHERE tb.id = tu.toilet_block_id
        AND f.id = tu.facility_id
        AND tu.qr_code IS NULL
    `);

    await queryInterface.sequelize.query(`
      UPDATE toilet_units
      SET qr_code = UPPER('UNIT-' || REPLACE(id::text, '-', ''))
      WHERE qr_code IS NULL
    `);

    await queryInterface.changeColumn('toilet_units', 'qr_code', {
      type: DataTypes.STRING(180),
      allowNull: false,
    });

    await queryInterface.addIndex('toilet_units', ['qr_code'], {
      name: 'toilet_units_qr_code_uk',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('toilet_units', 'toilet_units_qr_code_uk');
    await queryInterface.removeColumn('toilet_units', 'qr_code');
  },
};

