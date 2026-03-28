const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isBlank,
  sanitizeText,
  parsePositiveInteger,
  normalizePagination,
} = require('../src/utils/validators');
const {
  validateLogin,
  validateResetPassword,
} = require('../src/modules/auth/auth.validator');
const {
  validateCreateInspection,
} = require('../src/modules/inspections/inspection.validator');
const {
  validateIngestion,
} = require('../src/modules/sensors/sensor.validator');

test('sanitizeText removes unsafe markup-like characters', () => {
  const result = sanitizeText('   <script>alert(1)</script>  ', 100);
  assert.equal(result.includes('<'), false);
  assert.equal(result.includes('>'), false);
  assert.match(result, /scriptalert\(1\)\/script/);
});

test('parsePositiveInteger returns NaN for invalid values', () => {
  assert.equal(Number.isNaN(parsePositiveInteger('0')), true);
  assert.equal(Number.isNaN(parsePositiveInteger('-1')), true);
  assert.equal(Number.isNaN(parsePositiveInteger('abc')), true);
  assert.equal(parsePositiveInteger('4'), 4);
});

test('normalizePagination clamps limit and calculates offset', () => {
  const result = normalizePagination(
    { page: '2', limit: '999' },
    { page: 1, limit: 20, maxLimit: 50 }
  );
  assert.equal(result.page, 2);
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 50);
});

test('validateLogin requires identifier and password', () => {
  const errors = validateLogin({ body: { identifier: '', password: '' } });
  assert.deepEqual(errors, ['identifier is required', 'password is required']);
});

test('validateResetPassword enforces minimum password length', () => {
  const errors = validateResetPassword({ body: { token: 'abc', newPassword: '123' } });
  assert.deepEqual(errors, ['newPassword must be at least 8 characters']);
});

test('validateCreateInspection validates required fields', () => {
  const errors = validateCreateInspection({ body: {} });
  assert.deepEqual(errors, ['facilityId is required', 'inspectionType is required']);
});

test('validateIngestion validates sensor payload basics', () => {
  const errors = validateIngestion({ body: { deviceId: '', timestamp: 'not-a-date' } });
  assert.deepEqual(errors, ['deviceId is required', 'timestamp must be a valid date']);
});

test('isBlank handles null/undefined/whitespace', () => {
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank('   '), true);
  assert.equal(isBlank('x'), false);
});
