const { after, test } = require('node:test');
const assert = require('node:assert/strict');

const inspectionServicePath = require.resolve('../src/modules/inspections/inspection.service');
const evidenceService = require('../src/modules/inspections/inspectionEvidence.service');
const notificationService = require('../src/modules/notifications/notification.service');
const recipientResolver = require('../src/modules/notifications/notification.recipientResolver');
const { runtimeConfig } = require('../src/config/runtime');
const {
  Alert,
  AuditLog,
  Facility,
  Geography,
  Inspection,
  InspectionEvent,
  InspectionSubmission,
  ToiletUnit,
  sequelize,
} = require('../src/models');

const IDS = {
  tenant: '00000000-0000-0000-0000-000000000001',
  inspector: '00000000-0000-0000-0000-000000000002',
  reviewer: '00000000-0000-0000-0000-000000000003',
  legacyFacility: '00000000-0000-0000-0000-000000000101',
  mappedFacility: '00000000-0000-0000-0000-000000000102',
  legacyUnit: '00000000-0000-0000-0000-000000000201',
  mappedUnit: '00000000-0000-0000-0000-000000000202',
  mappedCity: '00000000-0000-0000-0000-000000000301',
};

const original = {
  alertCreate: Alert.create,
  auditLogCreate: AuditLog.create,
  evidenceRecompute: evidenceService.recomputeInspectionAggregates,
  facilityFindByPk: Facility.findByPk,
  geographyFindByPk: Geography.findByPk,
  inspectionEventCreate: InspectionEvent.create,
  inspectionFindByPk: Inspection.findByPk,
  inspectionSubmissionCreate: InspectionSubmission.create,
  inspectionSubmissionFindOne: InspectionSubmission.findOne,
  notificationPublish: notificationService.publishNotification,
  notificationPublishFromAuditLog: notificationService.publishFromAuditLog,
  resolveSupervisorIds: recipientResolver.resolveSupervisorIds,
  resolveUsersByRoleAndScope: recipientResolver.resolveUsersByRoleAndScope,
  triggerOnUpload: runtimeConfig.analysis.triggerOnUpload,
  toiletUnitFindByPk: ToiletUnit.findByPk,
};

after(async () => {
  Alert.create = original.alertCreate;
  AuditLog.create = original.auditLogCreate;
  evidenceService.recomputeInspectionAggregates = original.evidenceRecompute;
  Facility.findByPk = original.facilityFindByPk;
  Geography.findByPk = original.geographyFindByPk;
  InspectionEvent.create = original.inspectionEventCreate;
  Inspection.findByPk = original.inspectionFindByPk;
  InspectionSubmission.create = original.inspectionSubmissionCreate;
  InspectionSubmission.findOne = original.inspectionSubmissionFindOne;
  notificationService.publishNotification = original.notificationPublish;
  notificationService.publishFromAuditLog = original.notificationPublishFromAuditLog;
  recipientResolver.resolveSupervisorIds = original.resolveSupervisorIds;
  recipientResolver.resolveUsersByRoleAndScope = original.resolveUsersByRoleAndScope;
  runtimeConfig.analysis.triggerOnUpload = original.triggerOnUpload;
  ToiletUnit.findByPk = original.toiletUnitFindByPk;
  await sequelize.close();
});

test('legacy and mapped toilets complete the same inspection submission flow', async () => {
  const fixtures = [
    {
      label: 'legacy geography-less facility with no toilet block',
      facility: {
        id: IDS.legacyFacility,
        tenant_id: IDS.tenant,
        geography_id: null,
        zone_geography_id: null,
        ward_geography_id: null,
        name: 'Legacy Facility',
        status: 'active',
      },
      unit: {
        id: IDS.legacyUnit,
        facility_id: IDS.legacyFacility,
        toilet_block_id: null,
        code: 'LEGACY-01',
        status: 'active',
        deleted_at: null,
      },
    },
    {
      label: 'current geography-mapped facility with a toilet block',
      facility: {
        id: IDS.mappedFacility,
        tenant_id: IDS.tenant,
        geography_id: IDS.mappedCity,
        zone_geography_id: null,
        ward_geography_id: null,
        name: 'Mapped Facility',
        status: 'active',
      },
      unit: {
        id: IDS.mappedUnit,
        facility_id: IDS.mappedFacility,
        toilet_block_id: '00000000-0000-0000-0000-000000000401',
        code: 'MAPPED-01',
        status: 'active',
        deleted_at: null,
      },
    },
  ];
  const inspections = new Map();
  const createdSubmissions = [];
  const createdAlerts = [];
  const publishedNotifications = [];

  evidenceService.recomputeInspectionAggregates = async () => null;
  notificationService.publishFromAuditLog = async () => [];
  notificationService.publishNotification = async (payload) => {
    publishedNotifications.push(payload);
    return [];
  };
  recipientResolver.resolveSupervisorIds = async () => [IDS.reviewer];
  recipientResolver.resolveUsersByRoleAndScope = async () => [IDS.reviewer];
  runtimeConfig.analysis.triggerOnUpload = true;
  Facility.findByPk = async (id) =>
    fixtures.find((fixture) => fixture.facility.id === id)?.facility || null;
  Geography.findByPk = async (id) =>
    id === IDS.mappedCity
      ? { id: IDS.mappedCity, level: 'city', name: 'Mapped City', parent_id: null }
      : null;
  ToiletUnit.findByPk = async (id) =>
    fixtures.find((fixture) => fixture.unit.id === id)?.unit || null;
  Inspection.findByPk = async (id) => inspections.get(id) || null;
  InspectionSubmission.findOne = async () => null;
  InspectionSubmission.create = async (values) => {
    const row = {
      id: `00000000-0000-0000-0000-0000000005${createdSubmissions.length + 1}1`,
      ...values,
    };
    createdSubmissions.push(row);
    return row;
  };
  InspectionEvent.create = async (values) => values;
  AuditLog.create = async (values) => values;
  Alert.create = async (values) => {
    const row = {
      id: `00000000-0000-0000-0000-0000000006${createdAlerts.length + 1}1`,
      ...values,
    };
    createdAlerts.push(row);
    return row;
  };

  // Re-require after dependency doubles have been installed, because the
  // service captures its helper functions when it is loaded.
  delete require.cache[inspectionServicePath];
  const inspectionService = require(inspectionServicePath);

  for (const [index, fixture] of fixtures.entries()) {
    const inspectionId = `00000000-0000-0000-0000-0000000007${index + 1}1`;
    const updates = [];
    inspections.set(inspectionId, {
      id: inspectionId,
      tenant_id: IDS.tenant,
      facility_id: fixture.facility.id,
      toilet_unit_id: fixture.unit.id,
      inspector_user_id: IDS.inspector,
      inspection_type: 'after_cleaning',
      InspectionMedia: [
        {
          id: `before-${index}`,
          capture_stage: 'before',
          upload_status: 'confirmed',
          media_type: 'image',
          file_url: `/before-${index}.jpg`,
        },
        {
          id: `after-${index}`,
          capture_stage: 'after',
          upload_status: 'confirmed',
          media_type: 'image',
          file_url: `/after-${index}.jpg`,
        },
      ],
      Facility: fixture.facility,
      ToiletUnit: fixture.unit,
      inspector: { id: IDS.inspector, full_name: 'Field Worker' },
      update: async (values) => {
        updates.push(values);
      },
    });

    const result = await inspectionService.submitInspection({
      params: { id: inspectionId },
      body: {
        clientSubmissionId: `submission-${index}`,
        submittedAt: '2026-08-03T10:00:00.000Z',
      },
      user: {
        id: IDS.inspector,
        tenantId: IDS.tenant,
        isSuperAdmin: false,
        roleCodes: ['field_worker'],
        scopeLevel: 'facility',
        scopeFacilityIds: [],
      },
      headers: {},
      header: () => null,
    });

    const submission = createdSubmissions.at(-1);
    const alert = createdAlerts.at(-1);
    assert.equal(submission.inspection_id, inspectionId, fixture.label);
    assert.equal(submission.tenant_id, IDS.tenant, fixture.label);
    assert.equal(submission.submitted_to_role, 'supervisor', fixture.label);
    assert.equal(submission.submitted_to_scope, 'facility', fixture.label);
    assert.equal(alert.facility_id, fixture.facility.id, fixture.label);
    assert.equal(result.inspectionId, inspectionId, fixture.label);
    assert.equal(result.submissionId, submission.id, fixture.label);
    assert.equal(result.alertId, alert.id, fixture.label);
    assert.equal(result.processingStatus, 'queued_for_ai', fixture.label);
    assert.equal(updates[0].status, 'SUBMITTED', fixture.label);
  }

  assert.equal(publishedNotifications.length, fixtures.length);
  assert.deepEqual(publishedNotifications[0].recipients, [IDS.reviewer]);
});
