'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../src/models');
const reportService = require('../src/modules/reports/report.service');

const originalFindAll = {
  Facility: models.Facility.findAll,
  ToiletUnit: models.ToiletUnit.findAll,
  Inspection: models.Inspection.findAll,
  Complaint: models.Complaint.findAll,
};

test.afterEach(() => {
  models.Facility.findAll = originalFindAll.Facility;
  models.ToiletUnit.findAll = originalFindAll.ToiletUnit;
  models.Inspection.findAll = originalFindAll.Inspection;
  models.Complaint.findAll = originalFindAll.Complaint;
});

test('facility performance uses grouped aggregates without materializing report rows', async () => {
  let facilityOptions;
  let inspectionOptions;
  let complaintOptions;

  models.ToiletUnit.findAll = async () => [];
  models.Facility.findAll = async (options) => {
    facilityOptions = options;
    return [
      { id: 'facility-1', code: 'FAC-01', name: 'Central Facility' },
      { id: 'facility-2', code: 'FAC-02', name: 'North Facility' },
    ];
  };
  models.Inspection.findAll = async (options) => {
    inspectionOptions = options;
    return [
      {
        facility_id: 'facility-1',
        inspectionCount: '12',
        cleanlinessAverage: '81.236',
      },
    ];
  };
  models.Complaint.findAll = async (options) => {
    complaintOptions = options;
    return [{ facility_id: 'facility-1', complaintCount: '3' }];
  };

  const result = await reportService.getFacilityPerformanceReport({
    query: {},
    user: {
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      scopeLevel: 'organization',
      scopeFacilityIds: [],
    },
  });

  assert.deepEqual(facilityOptions.attributes, ['id', 'code', 'name']);
  assert.equal(facilityOptions.raw, true);
  assert.deepEqual(inspectionOptions.group, ['Inspection.facility_id']);
  assert.equal(inspectionOptions.raw, true);
  assert.deepEqual(inspectionOptions.include[0].attributes, []);
  assert.deepEqual(complaintOptions.group, ['Complaint.facility_id']);
  assert.equal(complaintOptions.raw, true);

  assert.deepEqual(result, [
    {
      facilityId: 'facility-1',
      facilityCode: 'FAC-01',
      facilityName: 'Central Facility',
      inspections: 12,
      complaints: 3,
      cleanlinessAverage: 81.24,
    },
    {
      facilityId: 'facility-2',
      facilityCode: 'FAC-02',
      facilityName: 'North Facility',
      inspections: 0,
      complaints: 0,
      cleanlinessAverage: 0,
    },
  ]);
});
