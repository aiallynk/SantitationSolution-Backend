const AppError = require('../../core/errors/AppError');
const { Complaint, Facility, ToiletUnit } = require('../../models');
const { sanitizeText, normalizePagination } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');

const mapComplaint = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  facilityId: row.facility_id,
  toiletUnitId: row.toilet_unit_id,
  reporterUserId: row.reporter_user_id,
  complaintType: row.complaint_type,
  description: row.description,
  status: row.status,
  priority: row.priority,
  assignedToUserId: row.assigned_to_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const loadScopedComplaint = async (req) => {
  const complaint = await Complaint.findByPk(req.params.id);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, { code: 'COMPLAINT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && complaint.tenant_id !== req.user.tenantId) {
    throw new AppError('Complaint out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return complaint;
};

const listComplaints = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = {};
  if (!req.user.isSuperAdmin) {
    where.tenant_id = req.user.tenantId;
  }
  if (req.query.status) where.status = req.query.status;
  if (req.query.priority) where.priority = req.query.priority;
  if (req.query.facilityId) where.facility_id = req.query.facilityId;

  const { rows, count } = await Complaint.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map(mapComplaint),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createComplaint = async (req) => {
  const facility = req.body.facilityId ? await Facility.findByPk(req.body.facilityId) : null;
  if (req.body.facilityId && !facility) {
    throw new AppError('facilityId is invalid', 400, { code: 'FACILITY_NOT_FOUND' });
  }
  if (facility && !req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('facilityId is out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (req.body.toiletUnitId) {
    const unit = await ToiletUnit.findByPk(req.body.toiletUnitId);
    if (!unit) {
      throw new AppError('toiletUnitId is invalid', 400, { code: 'UNIT_NOT_FOUND' });
    }
  }

  const complaint = await Complaint.create({
    tenant_id: facility?.tenant_id || req.user.tenantId,
    facility_id: req.body.facilityId || null,
    toilet_unit_id: req.body.toiletUnitId || null,
    reporter_user_id: req.user.id,
    complaint_type: sanitizeText(req.body.complaintType || 'general', 120),
    description: sanitizeText(req.body.description, 1000),
    status: 'open',
    priority: req.body.priority || 'medium',
  });

  await createAuditLog({
    req,
    action: 'complaint.create',
    entityType: 'complaint',
    entityId: complaint.id,
    tenantId: complaint.tenant_id,
  });

  return mapComplaint(complaint);
};

const assignComplaint = async (req) => {
  const complaint = await loadScopedComplaint(req);
  const assignedToUserId = req.body.assignedToUserId || null;

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

  return mapComplaint(complaint);
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

  return mapComplaint(complaint);
};

module.exports = {
  listComplaints,
  createComplaint,
  assignComplaint,
  resolveComplaint,
};
