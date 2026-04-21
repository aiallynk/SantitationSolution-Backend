const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  Complaint,
  Facility,
  ToiletUnit,
  PlatformUser,
  WorkerAssignment,
  UserRole,
  Role,
  Inspection,
  CleaningEvent,
} = require('../../models');
const { sanitizeText, normalizePagination, isUuid } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { uploadImage, removeTempFile } = require('../media/storage.service');
const { resolveMediaUrl } = require('../media/mediaUrl.service');
const { ROLE_CODES } = require('../../core/rbac/personaFamilies');
const { getPublicFeedbackUrl } = require('../platform/toiletQr.service');
const notificationService = require('../notifications/notification.service');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const allowedPriorities = new Set(['low', 'medium', 'high', 'critical']);
const allowedSourceChannels = new Set([
  'field_app',
  'public_qr',
  'helpline',
  'admin_portal',
]);

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const unique = (values = []) => [...new Set(values.filter(Boolean).map((value) => String(value)))];

const scopedWhere = (req, where = {}, domainType = 'complaint') =>
  applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), domainType, {
    tenantKey: 'tenant_id',
    facilityKey: 'facility_id',
  });

const normalizePriority = (value, fallback = 'medium') => {
  const normalized = String(value || fallback).trim().toLowerCase();
  return allowedPriorities.has(normalized) ? normalized : fallback;
};

const normalizeSourceChannel = (value, fallback = 'field_app') => {
  const normalized = String(value || fallback).trim().toLowerCase();
  return allowedSourceChannels.has(normalized) ? normalized : fallback;
};

const complaintInclude = () => [
  {
    model: Facility,
    attributes: [
      'id',
      'tenant_id',
      'geography_id',
      'name',
      'code',
      'address_line',
      'latitude',
      'longitude',
    ],
    required: false,
  },
  {
    model: ToiletUnit,
    attributes: [
      'id',
      'facility_id',
      'code',
      'qr_code',
      'sector_code',
      'location_label',
      'latitude',
      'longitude',
    ],
    include: [
      {
        model: Facility,
        attributes: [
          'id',
          'tenant_id',
          'geography_id',
          'name',
          'code',
          'address_line',
          'latitude',
          'longitude',
        ],
        required: false,
      },
    ],
    required: false,
  },
  {
    model: PlatformUser,
    as: 'reporter',
    attributes: ['id', 'full_name', 'email'],
    required: false,
  },
  {
    model: PlatformUser,
    as: 'assignedTo',
    attributes: ['id', 'full_name', 'email', 'employee_code'],
    required: false,
  },
  {
    model: PlatformUser,
    as: 'dispatchRequestedBy',
    attributes: ['id', 'full_name', 'email'],
    required: false,
  },
];

const mapComplaint = async (row, options = {}) => {
  const evidenceUrlCache = options.evidenceUrlCache || null;
  const toilet = row.ToiletUnit || null;
  const facility = row.Facility || toilet?.Facility || null;
  const latitude =
    toNumberOrNull(toilet?.latitude) ?? toNumberOrNull(facility?.latitude) ?? null;
  const longitude =
    toNumberOrNull(toilet?.longitude) ?? toNumberOrNull(facility?.longitude) ?? null;
  const evidenceImageUrl = await resolveMediaUrl(
    {
      fileUrl: row.evidence_image_url,
    },
    { cache: evidenceUrlCache }
  );

  return {
    id: row.id,
    tenantId: row.tenant_id,
    facilityId: row.facility_id || toilet?.facility_id || null,
    facilityCode: facility?.code || null,
    facilityName: facility?.name || null,
    facilityAddress: facility?.address_line || null,
    geographyId: facility?.geography_id || null,
    toiletUnitId: row.toilet_unit_id,
    toiletCode: toilet?.code || null,
    toiletQrCode: toilet?.qr_code || toilet?.code || null,
    toiletSectorCode: toilet?.sector_code || null,
    toiletLocationLabel: toilet?.location_label || facility?.address_line || facility?.name || null,
    latitude,
    longitude,
    publicFeedbackUrl: row.toilet_unit_id
      ? getPublicFeedbackUrl({ toiletUnitId: row.toilet_unit_id })
      : null,
    reporterUserId: row.reporter_user_id,
    reporterName: row.reporter?.full_name || row.reporter_name || null,
    reporterEmail: row.reporter?.email || null,
    reporterContact: row.reporter_contact || null,
    sourceChannel: row.source_channel || 'field_app',
    complaintType: row.complaint_type,
    description: row.description,
    evidenceImageUrl,
    status: row.status,
    priority: row.priority,
    assignedToUserId: row.assigned_to_user_id,
    assignedToName: row.assignedTo?.full_name || null,
    assignedToEmployeeCode: row.assignedTo?.employee_code || null,
    dispatchRequestedAt: row.dispatch_requested_at || null,
    dispatchRequestedByUserId: row.dispatch_requested_by_user_id || null,
    dispatchRequestedByName: row.dispatchRequestedBy?.full_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const resolveComplaintWithScope = async (req, complaintId, options = {}) => {
  const complaint = await Complaint.findByPk(complaintId, options);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, { code: 'COMPLAINT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && complaint.tenant_id !== req.user.tenantId) {
    throw new AppError('Complaint out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, complaint.facility_id || null)) {
    throw new AppError('Complaint out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return complaint;
};

const loadScopedComplaint = async (req, { include = false } = {}) =>
  resolveComplaintWithScope(req, req.params.id, include ? { include: complaintInclude() } : {});

const resolvePublicToilet = async (toiletIdOrCode) => {
  const raw = sanitizeText(toiletIdOrCode, 180);
  if (!raw) {
    throw new AppError('toiletId is required', 400, { code: 'TOILET_REQUIRED' });
  }

  const include = [
    {
      model: Facility,
      attributes: [
        'id',
        'tenant_id',
        'geography_id',
        'name',
        'code',
        'address_line',
        'latitude',
        'longitude',
      ],
      required: true,
    },
  ];

  let unit = null;
  if (isUuid(raw)) {
    unit = await ToiletUnit.findByPk(raw, { include });
  }
  if (!unit) {
    unit = await ToiletUnit.findOne({
      where: {
        [Op.or]: [{ code: { [Op.iLike]: raw } }, { qr_code: { [Op.iLike]: raw } }],
      },
      include,
    });
  }
  if (!unit) {
    throw new AppError('Toilet not found', 404, { code: 'TOILET_NOT_FOUND' });
  }
  return unit;
};

const ensureFacilityScope = (req, facility) => {
  if (!facility) return;
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('facilityId is out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('facilityId is out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
};

const ensureToiletScope = (req, toiletUnit) => {
  if (!toiletUnit) return;
  if (!req.user.isSuperAdmin && toiletUnit.Facility?.tenant_id !== req.user.tenantId) {
    throw new AppError('toiletUnitId is out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, toiletUnit.Facility?.id || toiletUnit.facility_id || null)) {
    throw new AppError('toiletUnitId is out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
};

const listComplaints = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  let where = scopedWhere(req, {}, 'complaint');
  if (req.query.status) where.status = String(req.query.status).toLowerCase();
  if (req.query.priority) where.priority = normalizePriority(req.query.priority);
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('facilityId is out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  if (req.query.toiletUnitId) where.toilet_unit_id = req.query.toiletUnitId;
  if (req.query.sourceChannel) {
    where.source_channel = normalizeSourceChannel(req.query.sourceChannel, 'field_app');
  }

  const { rows, count } = await Complaint.findAndCountAll({
    where,
    include: complaintInclude(),
    order: [['created_at', 'DESC']],
    distinct: true,
    limit,
    offset,
  });

  const evidenceUrlCache = new Map();
  const items = await Promise.all(
    rows.map((row) => mapComplaint(row, { evidenceUrlCache }))
  );

  return {
    items,
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const getComplaintById = async (req) => {
  const complaint = await loadScopedComplaint(req, { include: true });
  return mapComplaint(complaint);
};

const createComplaint = async (req) => {
  let facility = req.body.facilityId
    ? await Facility.findByPk(req.body.facilityId, {
        attributes: [
          'id',
          'tenant_id',
          'geography_id',
          'name',
          'code',
          'address_line',
          'latitude',
          'longitude',
        ],
      })
    : null;
  if (req.body.facilityId && !facility) {
    throw new AppError('facilityId is invalid', 400, { code: 'FACILITY_NOT_FOUND' });
  }

  let toiletUnit = null;
  if (req.body.toiletUnitId) {
    toiletUnit = await ToiletUnit.findByPk(req.body.toiletUnitId, {
      include: [
        {
          model: Facility,
          attributes: ['id', 'tenant_id'],
          required: true,
        },
      ],
    });
    if (!toiletUnit) {
      throw new AppError('toiletUnitId is invalid', 400, { code: 'UNIT_NOT_FOUND' });
    }
    if (!facility) {
      facility = toiletUnit.Facility || null;
    } else if (String(facility.id) !== String(toiletUnit.facility_id)) {
      throw new AppError('toiletUnitId does not belong to facilityId', 400, {
        code: 'TOILET_FACILITY_MISMATCH',
      });
    }
  }

  ensureFacilityScope(req, facility);
  ensureToiletScope(req, toiletUnit);

  const tenantId = facility?.tenant_id || req.user.tenantId;
  if (!tenantId) {
    throw new AppError('tenant scope could not be resolved for complaint', 400, {
      code: 'TENANT_REQUIRED',
    });
  }

  const complaint = await Complaint.create({
    tenant_id: tenantId,
    facility_id: facility?.id || null,
    toilet_unit_id: toiletUnit?.id || null,
    reporter_user_id: req.user.id,
    source_channel: normalizeSourceChannel(req.body.sourceChannel, 'field_app'),
    reporter_name: req.body.reporterName ? sanitizeText(req.body.reporterName, 180) : null,
    reporter_contact: req.body.reporterContact
      ? sanitizeText(req.body.reporterContact, 120)
      : null,
    complaint_type: sanitizeText(req.body.complaintType || 'general', 120),
    description: sanitizeText(req.body.description, 1000),
    evidence_image_url: req.body.evidenceImageUrl
      ? sanitizeText(req.body.evidenceImageUrl, 500)
      : null,
    status: 'open',
    priority: normalizePriority(req.body.priority, 'medium'),
  });

  await createAuditLog({
    req,
    action: 'complaint.create',
    entityType: 'complaint',
    entityId: complaint.id,
    tenantId: complaint.tenant_id,
    details: {
      sourceChannel: complaint.source_channel,
      facilityId: complaint.facility_id,
      toiletUnitId: complaint.toilet_unit_id,
    },
  });

  const hydrated = await Complaint.findByPk(complaint.id, {
    include: complaintInclude(),
  });
  return mapComplaint(hydrated || complaint);
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildPublicFeedbackPage = ({
  toilet,
  facility,
  submitPath,
  submitted = false,
  ticket = '',
  errorMessage = '',
}) => {
  const title = `Report Toilet Issue - ${toilet?.code || 'Toilet'}`;
  const locationText =
    toilet?.location_label || facility?.address_line || facility?.name || 'Location unavailable';
  const lat = toNumberOrNull(toilet?.latitude) ?? toNumberOrNull(facility?.latitude);
  const lng = toNumberOrNull(toilet?.longitude) ?? toNumberOrNull(facility?.longitude);
  const coordinateText =
    lat !== null && lng !== null ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : 'Coordinates unavailable';

  const successBlock = submitted
    ? `<div class="notice success">Thanks for reporting. Ticket ID: <strong>${escapeHtml(
        ticket || 'Generated'
      )}</strong></div>`
    : '';
  const errorBlock = errorMessage
    ? `<div class="notice error">${escapeHtml(errorMessage)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f5f7;
      --card: #ffffff;
      --line: #d8dee6;
      --text: #1f2937;
      --muted: #5b6b7c;
      --brand: #0f766e;
      --brand-dark: #0b5f58;
      --error: #b42318;
      --ok-bg: #e7f8f1;
      --ok-line: #79cda9;
      --err-bg: #fff4f2;
      --err-line: #f2b8b5;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      background: radial-gradient(circle at 20% 0%, #ffffff 0%, var(--bg) 60%);
      color: var(--text);
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      padding: 24px 16px 32px;
    }
    .card {
      border: 1px solid var(--line);
      background: var(--card);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      line-height: 1.25;
    }
    .subtle {
      color: var(--muted);
      font-size: 13px;
    }
    .meta {
      margin-top: 12px;
      padding: 12px;
      border-radius: 10px;
      border: 1px dashed var(--line);
      background: #fbfcfe;
      font-size: 13px;
      line-height: 1.55;
    }
    .notice {
      margin: 0 0 12px 0;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
    }
    .notice.success {
      background: var(--ok-bg);
      border: 1px solid var(--ok-line);
    }
    .notice.error {
      background: var(--err-bg);
      border: 1px solid var(--err-line);
      color: var(--error);
    }
    form {
      margin-top: 14px;
      display: grid;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
      font-weight: 600;
    }
    input, select, textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--text);
      background: #fff;
    }
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    .row {
      display: grid;
      gap: 12px;
    }
    @media (min-width: 720px) {
      .row.two {
        grid-template-columns: 1fr 1fr;
      }
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 10px;
      background: var(--brand);
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      padding: 12px 14px;
      cursor: pointer;
    }
    button:hover {
      background: var(--brand-dark);
    }
    .footnote {
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      <div class="subtle">Public sanitation feedback form</div>
      <div class="meta">
        <div><strong>Toilet ID:</strong> ${escapeHtml(toilet?.code || toilet?.id || 'N/A')}</div>
        <div><strong>Facility:</strong> ${escapeHtml(
          facility?.name || facility?.code || 'Unknown Facility'
        )}</div>
        <div><strong>Location:</strong> ${escapeHtml(locationText)}</div>
        <div><strong>Coordinates:</strong> ${escapeHtml(coordinateText)}</div>
      </div>

      ${successBlock}
      ${errorBlock}

      <form method="post" action="${escapeHtml(submitPath)}" enctype="multipart/form-data">
        <div class="row two">
          <label>
            Your Name (Optional)
            <input type="text" name="reporterName" maxlength="180" placeholder="Citizen name" />
          </label>
          <label>
            Contact (Optional)
            <input type="text" name="reporterContact" maxlength="120" placeholder="Phone or email" />
          </label>
        </div>
        <div class="row two">
          <label>
            Issue Type
            <select name="complaintType" required>
              <option value="cleanliness">Cleanliness</option>
              <option value="odor">Bad odor</option>
              <option value="water_supply">Water supply issue</option>
              <option value="damage">Damaged unit</option>
              <option value="accessibility">Accessibility issue</option>
              <option value="safety">Safety concern</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Priority
            <select name="priority" required>
              <option value="high">High</option>
              <option value="critical">Critical</option>
              <option value="medium" selected>Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>
        <label>
          Describe the issue
          <textarea name="description" required maxlength="1000" placeholder="Please explain what issue you observed."></textarea>
        </label>
        <label>
          Photo evidence
          <input type="file" name="photo" accept="image/*" capture="environment" required />
        </label>
        <button type="submit">Submit Feedback</button>
      </form>
      <div class="footnote">
        Your report is mapped to this toilet ID automatically so the operations team can act on the exact location.
      </div>
    </div>
  </div>
</body>
</html>`;
};

const getPublicFeedbackFormPage = async (req) => {
  const unit = await resolvePublicToilet(req.params.toiletId);
  const submitted = String(req.query.submitted || '').trim() === '1';
  const ticket = sanitizeText(req.query.ticket, 120);
  const errorMessage = sanitizeText(req.query.error, 240);
  const submitPath = `/api/v1/public-feedback/toilets/${encodeURIComponent(
    unit.id
  )}/report`;
  return buildPublicFeedbackPage({
    toilet: unit,
    facility: unit.Facility,
    submitPath,
    submitted,
    ticket,
    errorMessage,
  });
};

const createPublicComplaint = async (req) => {
  const unit = await resolvePublicToilet(req.params.toiletId);
  const facility = unit.Facility;
  const description = sanitizeText(req.body.description, 1000);
  if (!description) {
    throw new AppError('description is required', 400, { code: 'DESCRIPTION_REQUIRED' });
  }
  if (!req.file?.path) {
    throw new AppError('photo is required', 400, { code: 'PHOTO_REQUIRED' });
  }

  const folder = `sanitation/${facility.tenant_id}/public-feedback/${unit.id}`;
  let uploaded = null;
  try {
    uploaded = await uploadImage(req.file.path, folder);
  } finally {
    await removeTempFile(req.file.path);
  }

  const complaint = await Complaint.create({
    tenant_id: facility.tenant_id,
    facility_id: facility.id,
    toilet_unit_id: unit.id,
    reporter_user_id: null,
    source_channel: 'public_qr',
    reporter_name: req.body.reporterName ? sanitizeText(req.body.reporterName, 180) : null,
    reporter_contact: req.body.reporterContact
      ? sanitizeText(req.body.reporterContact, 120)
      : null,
    complaint_type: sanitizeText(req.body.complaintType || 'public_feedback', 120),
    description,
    evidence_image_url: uploaded?.fileUrl || null,
    status: 'open',
    priority: normalizePriority(req.body.priority, 'high'),
  });

  await createAuditLog({
    req,
    action: 'complaint.public_create',
    entityType: 'complaint',
    entityId: complaint.id,
    tenantId: complaint.tenant_id,
    details: {
      sourceChannel: 'public_qr',
      facilityId: facility.id,
      toiletUnitId: unit.id,
    },
  });

  const hydrated = await Complaint.findByPk(complaint.id, {
    include: complaintInclude(),
  });
  return mapComplaint(hydrated || complaint);
};

const assignComplaint = async (req) => {
  const complaint = await loadScopedComplaint(req);
  const assignedToUserId = req.body.assignedToUserId || null;

  if (assignedToUserId) {
    const assignee = await PlatformUser.findByPk(assignedToUserId, {
      attributes: ['id', 'tenant_id', 'status'],
    });
    if (!assignee || assignee.status !== 'active') {
      throw new AppError('assignedToUserId is invalid', 400, {
        code: 'ASSIGNEE_NOT_FOUND',
      });
    }
    if (!req.user.isSuperAdmin && assignee.tenant_id !== req.user.tenantId) {
      throw new AppError('assignedToUserId is out of tenant scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
  }

  await complaint.update({
    assigned_to_user_id: assignedToUserId,
    status: assignedToUserId ? 'assigned' : complaint.status,
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    action: 'complaint.assign',
    entityType: 'complaint',
    entityId: complaint.id,
    tenantId: complaint.tenant_id,
    details: { assignedToUserId },
  });

  const hydrated = await Complaint.findByPk(complaint.id, {
    include: complaintInclude(),
  });
  return mapComplaint(hydrated || complaint);
};

const resolveComplaint = async (req) => {
  const complaint = await loadScopedComplaint(req);
  await complaint.update({
    status: 'resolved',
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    action: 'complaint.resolve',
    entityType: 'complaint',
    entityId: complaint.id,
    tenantId: complaint.tenant_id,
  });

  const hydrated = await Complaint.findByPk(complaint.id, {
    include: complaintInclude(),
  });
  return mapComplaint(hydrated || complaint);
};

const loadRoleIdByCode = async (roleCode) => {
  const role = await Role.findOne({
    where: { code: roleCode },
    attributes: ['id'],
  });
  return role?.id || null;
};

const getUsersByRoleAndScope = async ({
  tenantId,
  roleCode,
  toiletUnitId = null,
  facilityId = null,
  geographyId = null,
}) => {
  const roleId = await loadRoleIdByCode(roleCode);
  if (!roleId) return [];

  const scopedAssignmentsWhere = [];
  if (toiletUnitId) scopedAssignmentsWhere.push({ toilet_unit_id: toiletUnitId });
  if (facilityId) scopedAssignmentsWhere.push({ facility_id: facilityId });
  if (geographyId) scopedAssignmentsWhere.push({ geography_id: geographyId });

  let assignmentScopedUserIds = [];
  if (scopedAssignmentsWhere.length > 0) {
    const assignmentRows = await WorkerAssignment.findAll({
      where: {
        tenant_id: tenantId,
        status: 'active',
        [Op.or]: scopedAssignmentsWhere,
      },
      attributes: ['user_id'],
    });
    assignmentScopedUserIds = unique(assignmentRows.map((row) => row.user_id));
  }

  const roleWhere = {
    role_id: roleId,
    tenant_id: tenantId,
  };
  if (assignmentScopedUserIds.length > 0) {
    roleWhere.user_id = { [Op.in]: assignmentScopedUserIds };
  }

  const roleRows = await UserRole.findAll({
    where: roleWhere,
    attributes: ['user_id'],
  });

  return unique(roleRows.map((row) => row.user_id));
};

const getLatestWorkerIdsByLocation = async ({ toiletUnitId = null, facilityId = null }) => {
  const workerIds = new Set();

  if (toiletUnitId) {
    const latestInspection = await Inspection.findOne({
      where: { toilet_unit_id: toiletUnitId },
      attributes: ['inspector_user_id'],
      order: [['submitted_at', 'DESC'], ['captured_at', 'DESC'], ['created_at', 'DESC']],
    });
    if (latestInspection?.inspector_user_id) {
      workerIds.add(String(latestInspection.inspector_user_id));
    }
  }

  const cleaningWhere = toiletUnitId
    ? { toilet_unit_id: toiletUnitId }
    : facilityId
      ? { facility_id: facilityId }
      : null;
  if (cleaningWhere) {
    const latestCleaning = await CleaningEvent.findOne({
      where: cleaningWhere,
      attributes: ['worker_id'],
      order: [['end_time', 'DESC'], ['start_time', 'DESC'], ['created_at', 'DESC']],
    });
    if (latestCleaning?.worker_id) {
      workerIds.add(String(latestCleaning.worker_id));
    }
  }

  return Array.from(workerIds.values());
};

const getActiveUserSummaries = async (userIds = []) => {
  const ids = unique(userIds);
  if (ids.length === 0) return [];

  const rows = await PlatformUser.findAll({
    where: {
      id: { [Op.in]: ids },
      status: 'active',
    },
    attributes: ['id', 'full_name', 'email', 'employee_code'],
    order: [['full_name', 'ASC']],
  });

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    employeeCode: row.employee_code || null,
  }));
};

const dispatchComplaint = async (req) => {
  const complaint = await loadScopedComplaint(req, { include: true });
  if (complaint.status === 'resolved') {
    throw new AppError('Resolved complaint cannot be dispatched', 409, {
      code: 'COMPLAINT_ALREADY_RESOLVED',
    });
  }

  const toilet = complaint.ToiletUnit || null;
  const facility = complaint.Facility || toilet?.Facility || null;
  const tenantId = complaint.tenant_id;
  const geographyId = facility?.geography_id || null;
  const toiletUnitId = complaint.toilet_unit_id || null;
  const facilityId = complaint.facility_id || toilet?.facility_id || null;

  const [assignmentWorkers, historyWorkers, assignmentSupervisors] = await Promise.all([
    getUsersByRoleAndScope({
      tenantId,
      roleCode: ROLE_CODES.FIELD_WORKER,
      toiletUnitId,
      facilityId,
      geographyId,
    }),
    getLatestWorkerIdsByLocation({ toiletUnitId, facilityId }),
    getUsersByRoleAndScope({
      tenantId,
      roleCode: ROLE_CODES.SUPERVISOR,
      toiletUnitId,
      facilityId,
      geographyId,
    }),
  ]);

  const fallbackSupervisors =
    assignmentSupervisors.length > 0
      ? assignmentSupervisors
      : await getUsersByRoleAndScope({
          tenantId,
          roleCode: ROLE_CODES.SUPERVISOR,
        });

  const workerIds = unique([...assignmentWorkers, ...historyWorkers]);
  const supervisorIds = unique(
    fallbackSupervisors.filter((id) => !workerIds.includes(String(id)))
  );

  const [workerUsers, supervisorUsers] = await Promise.all([
    getActiveUserSummaries(workerIds),
    getActiveUserSummaries(supervisorIds),
  ]);

  if (workerUsers.length === 0 && supervisorUsers.length === 0) {
    throw new AppError(
      'No active workers or supervisors were found for this location scope',
      404,
      { code: 'DISPATCH_RECIPIENTS_NOT_FOUND' }
    );
  }

  const dispatchMessage =
    sanitizeText(req.body.message, 300) ||
    'New issue reported via public feedback QR. Please inspect and resolve.';
  const now = new Date();
  const dispatchEvidenceImageUrl = await resolveMediaUrl({
    fileUrl: complaint.evidence_image_url,
  });
  const payloadBase = {
    complaintId: complaint.id,
    complaintType: complaint.complaint_type,
    priority: complaint.priority,
    sourceChannel: complaint.source_channel || 'field_app',
    description: complaint.description,
    evidenceImageUrl: dispatchEvidenceImageUrl,
    facilityId,
    facilityCode: facility?.code || null,
    facilityName: facility?.name || null,
    toiletUnitId,
    toiletCode: toilet?.code || null,
    toiletLocationLabel:
      toilet?.location_label || facility?.address_line || facility?.name || null,
    latitude:
      toNumberOrNull(toilet?.latitude) ?? toNumberOrNull(facility?.latitude) ?? null,
    longitude:
      toNumberOrNull(toilet?.longitude) ?? toNumberOrNull(facility?.longitude) ?? null,
    dispatchMessage,
    requestedByUserId: req.user.id,
    requestedByName: req.user.fullName || null,
    requestedAt: now.toISOString(),
  };

  if (workerUsers.length > 0) {
    await notificationService.publishNotification({
      recipients: workerUsers.map((worker) => worker.id),
      eventType: 'complaint.dispatch',
      notificationType: 'COMPLAINT',
      priority: complaint.priority === 'critical' ? 'CRITICAL' : 'HIGH',
      title: 'Complaint assigned to worker',
      body: dispatchMessage,
      shortBody: dispatchMessage,
      entityType: 'complaint',
      entityId: complaint.id,
      route: `/ops/complaints/${complaint.id}`,
      iconKey: 'complaint',
      severity: complaint.priority,
      tenantId,
      geographyId,
      facilityId,
      audienceKind: 'TARGETED_LIST',
      createdByUserId: req.user.id,
      dedupeKey: `complaint.dispatch.worker:${complaint.id}:${now.toISOString().slice(0, 16)}`,
      metadata: {
        audience: 'worker',
      },
      payload: {
        ...payloadBase,
        audience: 'worker',
      },
    });
  }

  if (supervisorUsers.length > 0) {
    await notificationService.publishNotification({
      recipients: supervisorUsers.map((supervisor) => supervisor.id),
      eventType: 'complaint.dispatch',
      notificationType: 'COMPLAINT',
      priority: complaint.priority === 'critical' ? 'CRITICAL' : 'HIGH',
      title: 'Complaint escalated to supervisor',
      body: dispatchMessage,
      shortBody: dispatchMessage,
      entityType: 'complaint',
      entityId: complaint.id,
      route: `/ops/complaints/${complaint.id}`,
      iconKey: 'complaint',
      severity: complaint.priority,
      tenantId,
      geographyId,
      facilityId,
      audienceKind: 'TARGETED_LIST',
      createdByUserId: req.user.id,
      dedupeKey: `complaint.dispatch.supervisor:${complaint.id}:${now.toISOString().slice(0, 16)}`,
      metadata: {
        audience: 'supervisor',
      },
      payload: {
        ...payloadBase,
        audience: 'supervisor',
      },
    });
  }

  const nextAssignedTo = complaint.assigned_to_user_id || workerUsers[0]?.id || null;
  await complaint.update({
    assigned_to_user_id: nextAssignedTo,
    status: nextAssignedTo ? 'assigned' : complaint.status,
    dispatch_requested_at: now,
    dispatch_requested_by_user_id: req.user.id,
    updated_at: now,
  });

  await createAuditLog({
    req,
    action: 'complaint.dispatch',
    entityType: 'complaint',
    entityId: complaint.id,
    tenantId,
    details: {
      workerRecipients: workerUsers.length,
      supervisorRecipients: supervisorUsers.length,
      assignedToUserId: nextAssignedTo,
    },
  });

  const hydrated = await Complaint.findByPk(complaint.id, {
    include: complaintInclude(),
  });

  return {
    complaint: await mapComplaint(hydrated || complaint),
    dispatch: {
      totalRecipients: workerUsers.length + supervisorUsers.length,
      workers: workerUsers,
      supervisors: supervisorUsers,
    },
  };
};

module.exports = {
  listComplaints,
  getComplaintById,
  createComplaint,
  getPublicFeedbackFormPage,
  createPublicComplaint,
  assignComplaint,
  resolveComplaint,
  dispatchComplaint,
};
