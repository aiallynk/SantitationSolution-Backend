const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractQrCandidates,
  findDuplicateExactMatchIds,
  classifyResolvedToilet,
  QR_RESOLVE_REASON_CODES,
  resolveToiletFromQr,
  buildAutoToiletId,
} = require('../src/modules/platform/platform.service');
const { ToiletUnit, sequelize } = require('../src/models');

test('extractQrCandidates handles malformed payload safely', () => {
  const malformed = '{"qrCode":"FAC-1"';
  const candidates = extractQrCandidates(malformed);

  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length > 0);
});

test('extractQrCandidates parses URL and strips .png suffix', () => {
  const value =
    'https://example.org/static/qr/toilets/550e8400-e29b-41d4-a716-446655440000.png';
  const candidates = extractQrCandidates(value);

  assert.ok(candidates.includes('550E8400-E29B-41D4-A716-446655440000'));
});

test('findDuplicateExactMatchIds detects duplicate mappings', () => {
  const rows = [
    {
      id: 'unit-1',
      qr_code: 'FAC-001',
      code: 'A-01',
    },
    {
      id: 'unit-2',
      qr_code: 'FAC-001',
      code: 'A-02',
    },
  ];
  const duplicates = findDuplicateExactMatchIds(rows, ['FAC-001']);

  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.includes('unit-1'));
  assert.ok(duplicates.includes('unit-2'));
});

test('buildAutoToiletId skips codes already used anywhere in facility', async () => {
  const originalQuery = sequelize.query.bind(sequelize);
  sequelize.query = async (sql, opts) => {
    const normalizedCode = opts?.replacements?.normalizedCode;
    if (
      normalizedCode === 'NORTH-GATE-BLK-001' ||
      normalizedCode === 'NORTH-GATE-BLK-002'
    ) {
      return [{ id: 'existing' }];
    }
    return [];
  };

  try {
    const code = await buildAutoToiletId({
      facility: { id: 'facility-1', code: 'fac' },
      toiletBlock: { id: 'block-1', code: 'blk' },
      toiletName: 'North Gate',
    });
    assert.equal(code, 'NORTH-GATE-BLK-003');
  } finally {
    sequelize.query = originalQuery;
  }
});

test('classifyResolvedToilet returns inactive reason', () => {
  const req = {
    user: {
      isSuperAdmin: false,
      scopeLevel: 'facility',
      scopeFacilityIds: ['facility-1'],
    },
  };
  const row = {
    id: 'unit-1',
    status: 'out_of_service',
    facility_id: 'facility-1',
    Facility: { id: 'facility-1', status: 'active' },
  };

  const result = classifyResolvedToilet({ row, req });
  assert.equal(result, QR_RESOLVE_REASON_CODES.TOILET_INACTIVE);
});

test('classifyResolvedToilet returns out-of-scope reason', () => {
  const req = {
    user: {
      isSuperAdmin: false,
      scopeLevel: 'facility',
      scopeFacilityIds: ['facility-1'],
    },
  };
  const row = {
    id: 'unit-2',
    status: 'moderate',
    facility_id: 'facility-2',
    Facility: { id: 'facility-2', status: 'active' },
  };

  const result = classifyResolvedToilet({ row, req });
  assert.equal(result, QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE);
});

test('reason codes include unmapped and resolved outcomes', () => {
  assert.equal(
    QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED,
    'QR_NOT_MAPPED',
  );
  assert.equal(
    QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY,
    'QR_RESOLVED_SUCCESSFULLY',
  );
});

test('resolveToiletFromQr resolves mapped toilet QR', async (t) => {
  const originalFindAll = ToiletUnit.findAll;
  ToiletUnit.findAll = async () => [
    {
      id: 'unit-1',
      facility_id: 'facility-1',
      toilet_block_id: 'block-1',
      code: 'FAC-001-BLK-A-T001',
      qr_code: 'FAC-001-BLK-A-T001',
      unit_type: 'western',
      status: 'moderate',
      Facility: {
        id: 'facility-1',
        tenant_id: 'tenant-1',
        code: 'FAC-001',
        name: 'Ward Office',
        address_line: 'Main Road',
        latitude: 19.9975,
        longitude: 73.7898,
        metadata: {},
        status: 'active',
      },
    },
  ];
  t.after(() => {
    ToiletUnit.findAll = originalFindAll;
  });

  const req = {
    requestId: 'req-1',
    user: {
      id: 'worker-1',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      scopeLevel: 'facility',
      scopeFacilityIds: ['facility-1'],
    },
    query: {},
  };

  const result = await resolveToiletFromQr({
    req,
    rawQrValue: 'FAC-001-BLK-A-T001',
  });

  assert.equal(result.resolved, true);
  assert.equal(
    result.reasonCode,
    QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY
  );
  assert.equal(result.toilet?.id, 'unit-1');
});

test('resolveToiletFromQr returns QR_NOT_MAPPED when no lookup match exists', async (t) => {
  const originalFindAll = ToiletUnit.findAll;
  ToiletUnit.findAll = async () => [];
  t.after(() => {
    ToiletUnit.findAll = originalFindAll;
  });

  const req = {
    requestId: 'req-2',
    user: {
      id: 'worker-2',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      scopeLevel: 'facility',
      scopeFacilityIds: ['facility-1'],
    },
    query: {},
  };

  const result = await resolveToiletFromQr({
    req,
    rawQrValue: 'UNKNOWN-TOILET-QR',
  });

  assert.equal(result.resolved, false);
  assert.equal(result.reasonCode, QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED);
});

test('resolveToiletFromQr returns TOILET_NOT_IN_USER_SCOPE for real but unauthorized toilet', async (t) => {
  const originalFindAll = ToiletUnit.findAll;
  ToiletUnit.findAll = async () => [
    {
      id: 'unit-2',
      facility_id: 'facility-2',
      toilet_block_id: 'block-9',
      code: 'FAC-009-BLK-C-T021',
      qr_code: 'FAC-009-BLK-C-T021',
      unit_type: 'western',
      status: 'moderate',
      Facility: {
        id: 'facility-2',
        tenant_id: 'tenant-1',
        code: 'FAC-009',
        name: 'Cross Zone',
        status: 'active',
      },
    },
  ];
  t.after(() => {
    ToiletUnit.findAll = originalFindAll;
  });

  const req = {
    requestId: 'req-3',
    user: {
      id: 'worker-3',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      scopeLevel: 'facility',
      scopeFacilityIds: ['facility-1'],
    },
    query: {},
  };

  const result = await resolveToiletFromQr({
    req,
    rawQrValue: 'FAC-009-BLK-C-T021',
  });

  assert.equal(result.resolved, false);
  assert.equal(
    result.reasonCode,
    QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE
  );
});

test('resolveToiletFromQr returns INVALID_QR_FORMAT for empty payload', async () => {
  const req = {
    requestId: 'req-4',
    user: {
      id: 'worker-4',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      scopeLevel: 'facility',
      scopeFacilityIds: ['facility-1'],
    },
    query: {},
  };

  const result = await resolveToiletFromQr({
    req,
    rawQrValue: '   ',
  });

  assert.equal(result.resolved, false);
  assert.equal(result.reasonCode, QR_RESOLVE_REASON_CODES.INVALID_QR_FORMAT);
});
