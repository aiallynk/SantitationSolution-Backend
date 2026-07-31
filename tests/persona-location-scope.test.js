'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectPersonaLocationScopeErrors,
  normalizePersonaLocationNames,
} = require('../src/core/rbac/personaLocationScope');

const INDIA = {
  countryName: 'India',
  stateName: 'Maharashtra',
  districtName: 'Nashik',
  cityName: 'Nashik',
};

test('country admin can create state admin without lower-level fields', () => {
  const errors = collectPersonaLocationScopeErrors({
    actor: {
      roleCodes: ['country_admin'],
      countryName: 'India',
    },
    targetRoleCodes: ['state_admin'],
    locationNames: {
      countryName: 'India',
      stateName: 'Gujarat',
    },
    geographyLevel: 'state',
  });
  assert.deepEqual(errors, []);
});

test('state admin cannot create an admin in another state', () => {
  const errors = collectPersonaLocationScopeErrors({
    actor: {
      roleCodes: ['state_admin'],
      countryName: 'India',
      stateName: 'Maharashtra',
    },
    targetRoleCodes: ['district_admin'],
    locationNames: {
      countryName: 'India',
      stateName: 'Gujarat',
      districtName: 'Surat',
    },
    geographyLevel: 'district',
  });
  assert.equal(errors.some((error) => error.includes('stateName')), true);
});

test('district creator can create a city only inside the inherited district', () => {
  assert.deepEqual(
    collectPersonaLocationScopeErrors({
      actor: { roleCodes: ['district_admin'], ...INDIA },
      targetRoleCodes: ['city_admin'],
      locationNames: INDIA,
      geographyLevel: 'city',
    }),
    [],
  );
});

test('optional descendants are normalized to null', () => {
  assert.deepEqual(
    normalizePersonaLocationNames({
      roleCodes: ['state_admin'],
      locationNames: INDIA,
    }),
    {
      countryName: 'India',
      stateName: 'Maharashtra',
      districtName: null,
      cityName: null,
    },
  );
});
