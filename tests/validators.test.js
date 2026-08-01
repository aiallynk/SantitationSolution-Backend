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
  validateUpdateMe,
} = require('../src/modules/auth/auth.validator');
const {
  validateCreateInspection,
  validateSubmitInspection,
} = require('../src/modules/inspections/inspection.validator');
const {
  validateIngestion,
} = require('../src/modules/sensors/sensor.validator');
const {
  validateTenantCreate,
  validateGeographyCreate,
  validateQrResolve,
} = require('../src/modules/platform/platform.validator');
const {
  validateBroadcastSend,
} = require('../src/modules/notifications/notification.validator');

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

test('validateUpdateMe accepts valid IANA profile timezones and rejects invalid values', () => {
  assert.deepEqual(
    validateUpdateMe({
      body: { metadata: { preferences: { timezone: 'Europe/London' } } },
    }),
    [],
  );
  assert.deepEqual(
    validateUpdateMe({
      body: { metadata: { preferences: { timezone: 'Mars/Base' } } },
    }),
    ['metadata.preferences.timezone must be a valid IANA timezone'],
  );
});

test('validateCreateInspection validates required fields', () => {
  const errors = validateCreateInspection({ body: {} });
  assert.deepEqual(errors, ['facilityId is required', 'inspectionType is required']);
});

test('validateSubmitInspection accepts supported submission routing fields', () => {
  const errors = validateSubmitInspection({
    params: { id: 'e8d4d4ca-4f91-4e87-8fb5-6c1213f19e8d' },
    body: {
      clientSubmissionId: 'auditor-12345',
      submittedAt: '2026-05-18T08:30:00.000Z',
      submittedTo: 'ops_admin_city',
      severity: 'high',
    },
  });
  assert.deepEqual(errors, []);
});

test('validateSubmitInspection rejects unsupported submittedTo and severity values', () => {
  const errors = validateSubmitInspection({
    params: { id: 'e8d4d4ca-4f91-4e87-8fb5-6c1213f19e8d' },
    body: {
      submittedTo: 'ops_admin_state',
      severity: 'urgent',
    },
  });
  assert.deepEqual(errors, [
    'submittedTo must be one of supervisor|ops_admin_district|ops_admin_city',
    'severity must be one of low|medium|high|critical',
  ]);
});

test('validateIngestion validates sensor payload basics', () => {
  const errors = validateIngestion({ body: { deviceId: '', timestamp: 'not-a-date' } });
  assert.deepEqual(errors, ['deviceId is required', 'timestamp must be a valid date']);
});

test('validateQrResolve requires rawQrValue', () => {
  const errors = validateQrResolve({ body: {} });
  assert.deepEqual(errors, ['rawQrValue is required']);
});

test('validateQrResolve rejects invalid payload field types', () => {
  const errors = validateQrResolve({
    body: {
      rawQrValue: 123,
      normalizedQrValue: 42,
      workerId: true,
      tenantId: { id: 't-1' },
      siteId: ['s-1'],
      scannedAt: 'bad-date',
    },
  });
  assert.deepEqual(errors, [
    'rawQrValue must be a string',
    'normalizedQrValue must be a string when provided',
    'workerId must be a string when provided',
    'tenantId must be a string when provided',
    'siteId must be a string when provided',
    'scannedAt must be an ISO datetime when provided',
  ]);
});

test('validateQrResolve accepts supported request payload', () => {
  const errors = validateQrResolve({
    body: {
      rawQrValue: 'TOILET:FAC-001',
      normalizedQrValue: 'TOILET:FAC-001',
      workerId: 'worker-1',
      tenantId: 'tenant-1',
      siteId: 'site-1',
      scannedAt: '2026-04-08T12:30:00.000Z',
    },
  });
  assert.deepEqual(errors, []);
});

test('validateTenantCreate requires canonical geography ID for city scope', () => {
  const errors = validateTenantCreate({
    body: {
      name: 'Nashik Municipal Corporation',
      scopeLevel: 'city',
      countryName: 'India',
      stateName: 'Maharashtra',
      cityName: 'Nashik',
      geographyMapSelection: {
        latitude: 19.9975,
        longitude: 73.7898,
      },
    },
  });
  assert.deepEqual(errors, ['rootGeographyId is required for city scope']);
});

test('validateGeographyCreate requires Google map selection for city geographies', () => {
  const errors = validateGeographyCreate({
    body: {
      tenantId: 'tenant-1',
      level: 'city',
      name: 'Nashik',
      centroidLatitude: 19.9975,
      centroidLongitude: 73.7898,
      mapSource: 'manual_pin',
    },
  });
  assert.deepEqual(errors, [
    'city must use a Google Maps selection with valid coordinates and bounds',
  ]);
});

test('validateGeographyCreate allows zone without exact Google map selection', () => {
  const errors = validateGeographyCreate({
    body: {
      tenantId: 'tenant-1',
      level: 'zone',
      name: 'Zone 1',
    },
  });
  assert.deepEqual(errors, []);
});

test('isBlank handles null/undefined/whitespace', () => {
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank('   '), true);
  assert.equal(isBlank('x'), false);
});

test('validateBroadcastSend accepts a valid tenant role broadcast payload', () => {
  const errors = validateBroadcastSend({
    body: {
      audience: 'roles_in_tenant',
      tenantId: '11111111-1111-1111-8111-111111111111',
      roleCodes: ['field_worker', 'supervisor'],
      template: 'alert',
      title: 'Critical hygiene alert',
      body: 'Please inspect immediately.',
      priority: 'HIGH',
      notificationType: 'ALERT',
    },
  });
  assert.deepEqual(errors, []);
});

test('validateBroadcastSend enforces audience-specific required fields', () => {
  const errors = validateBroadcastSend({
    body: {
      audience: 'roles_in_tenant',
      title: 'x',
      body: 'y',
      roleCodes: [],
      userIds: ['not-a-uuid'],
    },
  });
  assert.deepEqual(errors, [
    'roleCodes is required when audience=roles_in_tenant',
    'userIds must only contain valid UUID values',
  ]);
});
