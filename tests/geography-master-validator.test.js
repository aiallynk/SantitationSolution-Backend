'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTenantProvision } = require('../src/modules/superAdmin/superAdmin.validator');
const { validateTenantCreate } = require('../src/modules/platform/platform.validator');

const officialTenantPayload = {
  name: 'Nashik Operations',
  code: 'NASHIK-OPS',
  scopeLevel: 'district',
  countryName: 'India',
  stateName: 'Maharashtra',
  districtName: 'Nashik',
};

test('official tenant provisioning requires a canonical root geography ID', () => {
  const errors = validateTenantProvision({ body: officialTenantPayload });
  assert.ok(errors.includes('rootGeographyId is required for district scope'));
});

test('canonical root geography ID removes the old map-search requirement', () => {
  const body = { ...officialTenantPayload, rootGeographyId: '11111111-1111-4111-8111-111111111111' };
  assert.deepEqual(validateTenantProvision({ body }), []);
  assert.deepEqual(validateTenantCreate({ body, user: { isSuperAdmin: true } }), []);
});
