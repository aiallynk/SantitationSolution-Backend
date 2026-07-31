const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateUser,
  validatePatchUser,
} = require('../src/modules/users/user.validator');

test('validateCreateUser requires either ids or complete names for scoped admin roles', () => {
  const errors = validateCreateUser({
    body: {
      fullName: 'Scoped Admin',
      email: 'scoped@example.com',
      password: 'Password@123',
      roleCodes: ['state_admin'],
      geographyId: null,
      assignments: [],
    },
  });
  assert.equal(
    errors.some((error) => error.includes('Scoped ops admin roles')),
    true,
  );
});

test('validateCreateUser rejects removed role codes', () => {
  const errors = validateCreateUser({
    body: {
      fullName: 'Removed Role User',
      email: 'removed@example.com',
      password: 'Password@123',
      roleCodes: ['facility_manager'],
      assignments: [{ assignmentLevel: 'facility', facilityId: '11111111-1111-4111-8111-111111111111' }],
    },
  });
  assert.equal(
    errors.some((error) => error.includes('unsupported values: facility_manager')),
    true,
  );
});

test('validateCreateUser accepts a state admin with country and state names only', () => {
  const errors = validateCreateUser({
    body: {
      fullName: 'State Admin',
      email: 'state@example.com',
      password: 'Password@123',
      roleCodes: ['state_admin'],
      countryName: 'India',
      stateName: 'Maharashtra',
      geographyId: null,
      assignments: [],
    },
  });
  assert.equal(
    errors.some((error) => error.includes('Scoped ops admin roles')),
    false,
  );
});

test('validatePatchUser checks scoped role errors when roleCodes are supplied', () => {
  const errors = validatePatchUser({
    body: {
      roleCodes: ['city_admin'],
      geographyId: null,
      assignments: [],
    },
  });
  assert.equal(
    errors.some((error) => error.includes('Scoped ops admin roles')),
    true,
  );
});

test('validatePatchUser validates email format when provided', () => {
  const errors = validatePatchUser({
    body: {
      email: 'invalid-email',
    },
  });
  assert.equal(errors.includes('email must be a valid email address'), true);
});

test('validateCreateUser validates email format', () => {
  const errors = validateCreateUser({
    body: {
      fullName: 'User One',
      email: 'bad-email-format',
      password: 'Password@123',
      roleCodes: ['field_worker'],
    },
  });
  assert.equal(errors.includes('email must be a valid email address'), true);
});

test('validateCreateUser rejects city and geography scope for district-admin field worker requests', () => {
  const errors = validateCreateUser({
    user: {
      roleCodes: ['district_admin'],
      scopeLevel: 'district',
    },
    body: {
      fullName: 'Worker One',
      email: 'worker@example.com',
      password: 'Password@123',
      roleCodes: ['field_worker'],
      cityName: 'Nashik',
      geographyId: '11111111-1111-4111-8111-111111111111',
      assignments: [
        {
          assignmentLevel: 'facility',
          facilityId: '22222222-2222-4222-8222-222222222222',
        },
      ],
    },
  });
  assert.equal(errors.includes('District Admin field_worker must not submit cityName'), true);
  assert.equal(errors.includes('District Admin field_worker must not submit geographyId'), true);
});

test('validatePatchUser rejects zone and geography assignment for district-admin field worker requests', () => {
  const errors = validatePatchUser({
    user: {
      roleCodes: ['district_admin'],
      scopeLevel: 'district',
    },
    body: {
      roleCodes: ['field_worker'],
      zoneName: 'Zone 1',
      assignments: [
        {
          assignmentLevel: 'zone',
          geographyId: '11111111-1111-4111-8111-111111111111',
        },
      ],
    },
  });
  assert.equal(errors.includes('District Admin field_worker must not submit zoneName'), true);
  assert.equal(
    errors.includes('assignments[0].geographyId is not allowed for District Admin field_worker'),
    true,
  );
});
