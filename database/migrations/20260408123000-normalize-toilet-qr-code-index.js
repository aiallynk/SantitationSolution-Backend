'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE toilet_units
      SET qr_code = UPPER(TRIM(qr_code))
      WHERE qr_code IS NOT NULL
    `);

    const [duplicates] = await queryInterface.sequelize.query(`
      SELECT
        UPPER(TRIM(qr_code)) AS normalized_qr,
        COUNT(*)::int AS row_count
      FROM toilet_units
      GROUP BY UPPER(TRIM(qr_code))
      HAVING COUNT(*) > 1
      LIMIT 25
    `);

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const preview = duplicates
        .map((item) => `${item.normalized_qr}(${item.row_count})`)
        .join(', ');
      throw new Error(
        `Cannot enforce normalized QR uniqueness due to duplicates: ${preview}`
      );
    }

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS toilet_units_qr_code_normalized_uk
      ON toilet_units (UPPER(TRIM(qr_code)))
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS toilet_units_qr_code_normalized_uk
    `);
  },
};
