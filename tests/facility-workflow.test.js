const test = require('node:test');
const assert = require('node:assert/strict');

const platformService = require('../src/modules/platform/platform.service');
const models = require('../src/models');
const notificationService = require('../src/modules/notifications/notification.service');

test('facility helpers validate polygon and circle boundaries', () => {
  const polygonArea = {
    geometry_type: 'polygon',
    geojson: {
      type: 'Polygon',
      coordinates: [[[72.8, 21.1], [72.9, 21.1], [72.9, 21.2], [72.8, 21.2], [72.8, 21.1]]],
    },
  };
  assert.doesNotThrow(() =>
    platformService.__private.assertFacilityLocationInsideArea({
      area: polygonArea,
      point: { latitude: 21.15, longitude: 72.85 },
    }),
  );
  assert.throws(
    () =>
      platformService.__private.assertFacilityLocationInsideArea({
        area: polygonArea,
        point: { latitude: 21.25, longitude: 72.95 },
      }),
    /outside the boundary of this Zone/,
  );

  const circleArea = {
    geometry_type: 'circle',
    boundary_center_latitude: 21.1702,
    boundary_center_longitude: 72.8311,
    boundary_radius_meters: 500,
  };
  assert.doesNotThrow(() =>
    platformService.__private.assertFacilityLocationInsideArea({
      area: circleArea,
      point: { latitude: 21.1702, longitude: 72.8311 },
    }),
  );
  assert.throws(
    () =>
      platformService.__private.assertFacilityLocationInsideArea({
        area: circleArea,
        point: { latitude: 21.1802, longitude: 72.8411 },
      }),
    /outside the boundary of this Zone/,
  );
});

test('createFacility auto-generates stable-looking facility code and QR payload', async (t) => {
  const originals = {
    geographyFindByPk: models.Geography.findByPk,
    facilityFindOne: models.Facility.findOne,
    facilityCreate: models.Facility.create,
    facilityFindByPk: models.Facility.findByPk,
    facilityQrUpdate: models.FacilityQrCode.update,
    facilityQrCreate: models.FacilityQrCode.create,
    tenantFindByPk: models.Tenant.findByPk,
    auditCreate: models.AuditLog.create,
    notificationPublish: notificationService.publishFromAuditLog,
  };

  const rows = new Map([
    ['zone-1', {
      id: 'zone-1',
      tenant_id: 'tenant-1',
      parent_id: 'city-1',
      level: 'zone',
      name: 'Central Zone',
      code: 'ZONE-CENTRAL',
      geometry_type: 'polygon',
      geojson: {
        type: 'Polygon',
        coordinates: [[[72.8, 21.1], [72.9, 21.1], [72.9, 21.2], [72.8, 21.2], [72.8, 21.1]]],
      },
      is_active: true,
    }],
    ['city-1', {
      id: 'city-1',
      tenant_id: 'tenant-1',
      parent_id: null,
      level: 'city',
      name: 'Nashik',
      code: 'NASHIK',
      is_active: true,
    }],
  ]);

  models.Geography.findByPk = async (id) => rows.get(String(id)) || null;
  models.Facility.findOne = async () => null;
  models.Tenant.findByPk = async () => ({ id: 'tenant-1', code: 'NMC' });
  models.AuditLog.create = async (payload) => payload;
  notificationService.publishFromAuditLog = async () => {};

  let createdFacilityPayload = null;
  models.Facility.create = async (payload) => {
    createdFacilityPayload = payload;
    return {
      id: 'facility-1',
      tenant_id: payload.tenant_id,
      geography_id: payload.geography_id,
      zone_geography_id: payload.zone_geography_id,
      ward_geography_id: payload.ward_geography_id,
      supervisor_user_id: payload.supervisor_user_id,
      code: payload.code,
      name: payload.name,
      facility_type: payload.facility_type,
      address_line: payload.address_line,
      contact_name: payload.contact_name,
      contact_phone: payload.contact_phone,
      contact_email: payload.contact_email,
      latitude: payload.latitude,
      longitude: payload.longitude,
      map_display_address: payload.map_display_address,
      map_place_id: payload.map_place_id,
      map_source: payload.map_source,
      location_status: payload.location_status,
      status: payload.status,
      metadata: payload.metadata,
    };
  };

  let qrCreatePayload = null;
  models.FacilityQrCode.update = async () => [0];
  models.FacilityQrCode.create = async (payload) => {
    qrCreatePayload = payload;
    return payload;
  };
  models.Facility.findByPk = async () => ({
    id: 'facility-1',
    tenant_id: 'tenant-1',
    geography_id: 'zone-1',
    zone_geography_id: 'zone-1',
    ward_geography_id: null,
    supervisor_user_id: null,
    code: createdFacilityPayload.code,
    name: createdFacilityPayload.name,
    facility_type: createdFacilityPayload.facility_type,
    address_line: createdFacilityPayload.address_line,
    contact_name: createdFacilityPayload.contact_name,
    contact_phone: createdFacilityPayload.contact_phone,
    contact_email: createdFacilityPayload.contact_email,
    latitude: createdFacilityPayload.latitude,
    longitude: createdFacilityPayload.longitude,
    map_display_address: createdFacilityPayload.map_display_address,
    map_place_id: createdFacilityPayload.map_place_id,
    map_source: createdFacilityPayload.map_source,
    location_status: createdFacilityPayload.location_status,
    status: createdFacilityPayload.status,
    metadata: createdFacilityPayload.metadata,
    zone: { id: 'zone-1', name: 'Central Zone', level: 'zone' },
    ward: null,
    supervisor: null,
    qrCodes: [{ ...qrCreatePayload, created_at: new Date().toISOString() }],
  });

  t.after(() => {
    models.Geography.findByPk = originals.geographyFindByPk;
    models.Facility.findOne = originals.facilityFindOne;
    models.Facility.create = originals.facilityCreate;
    models.Facility.findByPk = originals.facilityFindByPk;
    models.FacilityQrCode.update = originals.facilityQrUpdate;
    models.FacilityQrCode.create = originals.facilityQrCreate;
    models.Tenant.findByPk = originals.tenantFindByPk;
    models.AuditLog.create = originals.auditCreate;
    notificationService.publishFromAuditLog = originals.notificationPublish;
  });

  const result = await platformService.createFacility({
    body: {
      tenantId: 'tenant-1',
      areaId: 'zone-1',
      name: 'Bus Stand Facility',
      facilityType: 'public_toilet',
      status: 'active',
      addressLine: 'Main Bus Stand',
      contactName: 'Caretaker A',
      contactPhone: '9999999999',
    },
    user: { id: 'user-1', tenantId: 'tenant-1', isSuperAdmin: true },
    headers: {},
  });

  assert.match(createdFacilityPayload.code, /^FAC-ZONE-CENTRAL-2026-\d{4}$/);
  assert.equal(createdFacilityPayload.location_status, 'pending');
  assert.equal(createdFacilityPayload.status, 'location_pending');
  assert.equal(result.code, createdFacilityPayload.code);
  assert.equal(result.locationStatus, 'pending');
  assert.equal(result.areaName, 'Central Zone');
  assert.equal(typeof result.qr?.resolveUrl, 'string');
  assert.equal(result.qr?.resolveUrl.includes('/api/v1/facilities/resolve?t='), true);
  assert.equal(qrCreatePayload.is_primary, true);
});

test('resolveFacilityFromQr routes authenticated inspectors to inspection flow', async (t) => {
  const originals = {
    facilityQrFindOne: models.FacilityQrCode.findOne,
    auditCreate: models.AuditLog.create,
    notificationPublish: notificationService.publishFromAuditLog,
  };

  const qrRow = {
    id: 'qr-1',
    facility: {
      id: 'facility-1',
      tenant_id: 'tenant-1',
      code: 'FAC-ZONE-CENTRAL-2026-0001',
      name: 'Bus Stand Facility',
    },
    async update() {
      return this;
    },
  };

  models.FacilityQrCode.findOne = async () => qrRow;
  models.AuditLog.create = async (payload) => payload;
  notificationService.publishFromAuditLog = async () => {};

  t.after(() => {
    models.FacilityQrCode.findOne = originals.facilityQrFindOne;
    models.AuditLog.create = originals.auditCreate;
    notificationService.publishFromAuditLog = originals.notificationPublish;
  });

  const result = await platformService.resolveFacilityFromQr({
    body: { token: 'fqr.1.tenant-1.facility-1.qr-1.token' },
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      permissionCodes: ['inspection.create'],
    },
    headers: {},
  });

  assert.equal(result.targetFlow, 'inspection_checkin');
  assert.equal(result.targetPath, '/ops/toilets?facilityId=facility-1');
});
