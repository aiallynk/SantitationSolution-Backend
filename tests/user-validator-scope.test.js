const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateUser,
  validatePatchUser,
} = require('../src/modules/users/user.validator');

test('validateCreateUser enforces geography for geography-scoped admin roles', () => {
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

test('validateCreateUser accepts facility scope assignment for facility_manager', () => {
  const errors = validateCreateUser({
    body: {
      fullName: 'Facility Manager',
      email: 'facility@example.com',
      password: 'Password@123',
      roleCodes: ['facility_manager'],
      assignments: [{ assignmentLevel: 'facility', facilityId: '11111111-1111-4111-8111-111111111111' }],
    },
  });
  assert.equal(errors.some((error) => error.includes('facility_manager role requires')), false);
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
