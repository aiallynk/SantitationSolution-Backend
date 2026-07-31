'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE geographies
      ADD COLUMN IF NOT EXISTS location_status VARCHAR(40) NOT NULL DEFAULT 'mapped';

      UPDATE geographies
      SET location_status = CASE
        WHEN centroid_latitude IS NOT NULL AND centroid_longitude IS NOT NULL THEN 'mapped'
        ELSE 'unmapped'
      END
      WHERE location_status IS NULL
         OR location_status NOT IN ('mapped', 'unmapped');
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE geographies DROP COLUMN IF EXISTS location_status;
    `);
  },
};
