'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex(
      'complaints',
      ['tenant_id', 'facility_id', 'toilet_unit_id'],
      { name: 'complaints_tenant_facility_toilet_idx' },
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'complaints',
      'complaints_tenant_facility_toilet_idx',
    );
  },
};
