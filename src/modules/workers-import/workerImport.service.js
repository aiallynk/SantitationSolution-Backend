const fs = require('fs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  PlatformUser,
  Role,
  UserRole,
  WorkerAssignment,
  Tenant,
  Geography,
  Facility,
  WorkerImportJob,
  WorkerImportRow,
} = require('../../models');
const { parseCsvText, stringifyCsv } = require('./csv.util');
const { removeTempFile } = require('../media/storage.service');
const { createAuditLog } = require('../audit/audit.service');
const { publishNotification } = require('../notifications/notification.service');
const {
  generateTemporaryPassword,
  hashPassword,
} = require('../auth/passwordLifecycle.service');

const FIELD_WORKER_ROLE_CODE = 'field_worker';
const SUPERVISOR_ROLE_CODE = 'supervisor';
const IMPORT_TEMPLATE_HEADERS = [
  'employee_code',
  'first_name',
  'middle_name',
  'last_name',
  'date_of_birth',
  'gender',
  'mobile_number',
  'email',
  'worker_type',
  'employment_type',
  'joining_date',
  'country_code',
  'state_code',
  'district_code',
  'city_code',
  'zone_code',
  'ward_code',
  'site_code',
  'shift_code',
  'supervisor_employee_code',
  'preferred_language',
];
const IMPORT_ROW_LIMIT = 1000;
const IMPORT_FILE_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;
const JOB_STATUSES = {
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  VALIDATED: 'VALIDATED',
  IMPORTING: 'IMPORTING',
  COMPLETED: 'COMPLETED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const LOGIN_IDENTIFIER_PRIORITY = ['mobile', 'email', 'employee_code'];
const DATE_FIELDS = new Set(['date_of_birth', 'joining_date']);
const REQUIRED_FIELDS = new Set(['employee_code', 'first_name']);
const FIELD_TO_LEVEL = {
  country_code: 'country',
  state_code: 'state',
  district_code: 'district',
  city_code: 'city',
  zone_code: 'zone',
  ward_code: 'ward',
};
const LEVEL_SEQUENCE = ['country', 'state', 'district', 'city', 'zone', 'ward'];

const normalizeText = (value, { preserveCase = false } = {}) => {
  const trimmed = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return preserveCase ? trimmed : trimmed.toLowerCase();
};

const normalizeCode = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

const normalizePhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits || null;
};

const normalizeEmail = (value) => {
  const email = String(value ?? '').trim().toLowerCase();
  return email || null;
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(value || '').trim());
const isValidPhone = (value) => {
  const digits = normalizePhone(value);
  return !digits || (digits.length >= 7 && digits.length <= 15);
};

const parseDate = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
  const slash = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  let year;
  let month;
  let day;
  if (iso.test(raw)) {
    [, year, month, day] = raw.match(iso);
  } else if (slash.test(raw)) {
    [, day, month, year] = raw.match(slash);
  } else {
    return { error: 'INVALID_DATE_FORMAT' };
  }
  const candidate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(candidate.getTime())) {
    return { error: 'INVALID_DATE_FORMAT' };
  }
  return { value: candidate.toISOString().slice(0, 10), date: candidate };
};

const buildFullName = ({ first_name, middle_name, last_name }) =>
  [first_name, middle_name, last_name].map((part) => String(part || '').trim()).filter(Boolean).join(' ');

const summarizeCounts = (rows = []) => {
  const summary = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    duplicate: 0,
    warnings: 0,
  };
  for (const row of rows) {
    const status = String(row.status || '').toUpperCase();
    if (status === 'VALID') summary.valid += 1;
    if (status === 'INVALID') summary.invalid += 1;
    if (status === 'DUPLICATE') summary.duplicate += 1;
    if (Array.isArray(row.warnings) && row.warnings.length > 0) summary.warnings += 1;
  }
  return summary;
};

const makeRowIssue = ({ code, field, message, severity = 'error' }) => ({
  code,
  field,
  message,
  severity,
});

const deriveIdentifier = (payload = {}) => {
  for (const kind of LOGIN_IDENTIFIER_PRIORITY) {
    if (kind === 'mobile' && payload.mobile_number) {
      return { kind, value: payload.mobile_number };
    }
    if (kind === 'email' && payload.email) {
      return { kind, value: payload.email };
    }
    if (kind === 'employee_code' && payload.employee_code) {
      return { kind, value: payload.employee_code };
    }
  }
  return { kind: 'employee_code', value: payload.employee_code || null };
};

const resolveScopePrefill = async (req) => {
  const scopedIds = new Set((req.user?.scopeGeographyIds || []).map(String));
  if (!req.user?.tenantId) return {};
  const geographies = scopedIds.size
    ? await Geography.findAll({
        where: { id: { [Op.in]: [...scopedIds] } },
        attributes: ['id', 'code', 'level'],
      })
    : [];
  const fixed = {};
  for (const geography of geographies) {
    const header = `${String(geography.level).toLowerCase()}_code`;
    if (!fixed[header]) fixed[header] = geography.code;
  }
  return fixed;
};

const loadImportReferenceData = async ({ tenantId, rows = [], transaction = null }) => {
  const geographyCodes = new Set();
  const siteCodes = new Set();
  const supervisorEmployeeCodes = new Set();
  const employeeCodes = new Set();
  const emails = new Set();
  const phones = new Set();

  for (const row of rows) {
    for (const header of Object.keys(FIELD_TO_LEVEL)) {
      if (row[header]) geographyCodes.add(normalizeCode(row[header]));
    }
    if (row.site_code) siteCodes.add(normalizeCode(row.site_code));
    if (row.supervisor_employee_code) supervisorEmployeeCodes.add(normalizeCode(row.supervisor_employee_code));
    if (row.employee_code) employeeCodes.add(normalizeCode(row.employee_code));
    if (row.email) emails.add(normalizeEmail(row.email));
    if (row.mobile_number) phones.add(normalizePhone(row.mobile_number));
  }

  const [tenant, geographies, facilities, supervisors, existingUsers, workerRole] = await Promise.all([
    Tenant.findByPk(tenantId, {
      attributes: ['id', 'name', 'code', 'scope_level', 'root_geography_id'],
      transaction,
    }),
    geographyCodes.size
      ? Geography.findAll({
          where: {
            [Op.or]: [
              { tenant_id: tenantId, code: { [Op.in]: [...geographyCodes] } },
              { tenant_id: null, code: { [Op.in]: [...geographyCodes] } },
            ],
          },
          attributes: ['id', 'tenant_id', 'parent_id', 'level', 'code', 'name'],
          transaction,
        })
      : [],
    siteCodes.size
      ? Facility.findAll({
          where: { tenant_id: tenantId, code: { [Op.in]: [...siteCodes] } },
          attributes: ['id', 'tenant_id', 'code', 'name', 'geography_id', 'zone_geography_id', 'ward_geography_id'],
          transaction,
        })
      : [],
    supervisorEmployeeCodes.size
      ? PlatformUser.findAll({
          where: { tenant_id: tenantId, employee_code: { [Op.in]: [...supervisorEmployeeCodes] } },
          attributes: ['id', 'employee_code', 'full_name'],
          include: [{
            model: Role,
            attributes: ['code'],
            through: { attributes: [] },
            required: true,
            where: { code: SUPERVISOR_ROLE_CODE },
          }],
          transaction,
        })
      : [],
    PlatformUser.findAll({
      where: {
        tenant_id: tenantId,
        [Op.or]: [
          employeeCodes.size ? { employee_code: { [Op.in]: [...employeeCodes] } } : null,
          emails.size ? { email: { [Op.in]: [...emails] } } : null,
          phones.size ? { phone: { [Op.in]: [...phones] } } : null,
        ].filter(Boolean),
      },
      attributes: ['id', 'employee_code', 'email', 'phone', 'user_id_code', 'status'],
      transaction,
    }),
    Role.findOne({ where: { code: FIELD_WORKER_ROLE_CODE }, attributes: ['id', 'code'], transaction }),
  ]);

  if (!tenant) {
    throw new AppError('Tenant not found for import', 404, { code: 'TENANT_NOT_FOUND' });
  }
  if (!workerRole) {
    throw new AppError('Field worker role is not configured', 500, { code: 'ROLE_NOT_FOUND' });
  }

  return {
    tenant,
    workerRole,
    geographiesByCode: new Map(geographies.map((row) => [normalizeCode(row.code), row])),
    facilitiesByCode: new Map(facilities.map((row) => [normalizeCode(row.code), row])),
    supervisorsByEmployeeCode: new Map(supervisors.map((row) => [normalizeCode(row.employee_code), row])),
    existingByEmployeeCode: new Map(existingUsers.filter((row) => row.employee_code).map((row) => [normalizeCode(row.employee_code), row])),
    existingByEmail: new Map(existingUsers.filter((row) => row.email).map((row) => [normalizeEmail(row.email), row])),
    existingByPhone: new Map(existingUsers.filter((row) => row.phone).map((row) => [normalizePhone(row.phone), row])),
  };
};

const buildGeographyChain = async ({ geography, transaction = null }) => {
  const chain = [];
  let cursor = geography;
  let guard = 0;
  while (cursor && guard < 12) {
    chain.unshift(cursor);
    if (!cursor.parent_id) break;
    cursor = await Geography.findByPk(cursor.parent_id, {
      attributes: ['id', 'tenant_id', 'parent_id', 'level', 'code', 'name'],
      transaction,
    });
    guard += 1;
  }
  return chain;
};

const isGeographyAllowedForActor = async ({ req, geography, transaction = null }) => {
  if (!geography || req.user?.isSuperAdmin) return true;
  const scopedIds = new Set((req.user?.scopeGeographyIds || []).map(String));
  if (scopedIds.size === 0) return String(geography.tenant_id || '') === String(req.user?.tenantId || '');
  if (scopedIds.has(String(geography.id))) return true;
  let cursorId = geography.parent_id;
  let guard = 0;
  while (cursorId && guard < 12) {
    if (scopedIds.has(String(cursorId))) return true;
    const parent = await Geography.findByPk(cursorId, {
      attributes: ['id', 'parent_id'],
      transaction,
    });
    cursorId = parent?.parent_id || null;
    guard += 1;
  }
  return false;
};

const validateRow = async ({ req, row, rowNumber, fileDuplicateEmployeeCodes, references, transaction = null }) => {
  const errors = [];
  const warnings = [];
  const normalized = {};

  for (const header of IMPORT_TEMPLATE_HEADERS) {
    const rawValue = row[header];
    if (DATE_FIELDS.has(header)) {
      const parsed = parseDate(rawValue);
      if (parsed?.error) {
        errors.push(makeRowIssue({
          code: parsed.error,
          field: header,
          message: `${header} must be YYYY-MM-DD or DD/MM/YYYY`,
        }));
      }
      normalized[header] = parsed?.value || null;
      continue;
    }
    if (header.endsWith('_code') || header === 'employee_code' || header === 'supervisor_employee_code') {
      normalized[header] = normalizeCode(rawValue) || null;
      continue;
    }
    if (header === 'email') {
      normalized[header] = normalizeEmail(rawValue);
      continue;
    }
    if (header === 'mobile_number') {
      normalized[header] = normalizePhone(rawValue);
      continue;
    }
    normalized[header] = String(rawValue ?? '').trim() || null;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!normalized[field]) {
      errors.push(makeRowIssue({
        code: 'REQUIRED_FIELD_MISSING',
        field,
        message: `${field} is required`,
      }));
    }
  }

  if (normalized.email && !isValidEmail(normalized.email)) {
    errors.push(makeRowIssue({ code: 'INVALID_EMAIL', field: 'email', message: 'Email address is invalid' }));
  }
  if (normalized.mobile_number && !isValidPhone(normalized.mobile_number)) {
    errors.push(makeRowIssue({ code: 'INVALID_MOBILE', field: 'mobile_number', message: 'Mobile number is invalid' }));
  }

  if (normalized.date_of_birth) {
    const dobDate = new Date(`${normalized.date_of_birth}T00:00:00.000Z`);
    if (dobDate > new Date()) {
      errors.push(makeRowIssue({
        code: 'FUTURE_DATE_OF_BIRTH',
        field: 'date_of_birth',
        message: 'Date of birth cannot be in the future',
      }));
    }
  }

  if (normalized.employee_code && fileDuplicateEmployeeCodes.has(normalized.employee_code)) {
    errors.push(makeRowIssue({
      code: 'DUPLICATE_EMPLOYEE_CODE_IN_FILE',
      field: 'employee_code',
      message: 'Employee code appears more than once in the uploaded file',
    }));
  }

  if (normalized.employee_code && references.existingByEmployeeCode.has(normalized.employee_code)) {
    errors.push(makeRowIssue({
      code: 'EMPLOYEE_CODE_ALREADY_EXISTS',
      field: 'employee_code',
      message: 'Employee code already exists in this tenant',
    }));
  }
  if (normalized.email && references.existingByEmail.has(normalized.email)) {
    errors.push(makeRowIssue({
      code: 'LOGIN_IDENTIFIER_EXISTS',
      field: 'email',
      message: 'Email already exists for another user',
    }));
  }
  if (normalized.mobile_number && references.existingByPhone.has(normalized.mobile_number)) {
    errors.push(makeRowIssue({
      code: 'LOGIN_IDENTIFIER_EXISTS',
      field: 'mobile_number',
      message: 'Mobile number already exists for another user',
    }));
  }

  const resolvedGeographies = {};
  for (const [field, level] of Object.entries(FIELD_TO_LEVEL)) {
    if (!normalized[field]) continue;
    const geography = references.geographiesByCode.get(normalized[field]);
    if (!geography || String(geography.level) !== level) {
      errors.push(makeRowIssue({
        code: 'MASTER_DATA_NOT_FOUND',
        field,
        message: `${level} code was not found`,
      }));
      continue;
    }
    resolvedGeographies[level] = geography;
  }

  let deepestGeography = null;
  for (const level of LEVEL_SEQUENCE) {
    if (resolvedGeographies[level]) deepestGeography = resolvedGeographies[level];
  }

  if (deepestGeography) {
    const chain = await buildGeographyChain({ geography: deepestGeography, transaction });
    const chainByLevel = new Map(chain.map((item) => [String(item.level), item]));
    for (const level of LEVEL_SEQUENCE) {
      const header = `${level}_code`;
      if (!normalized[header]) continue;
      const expected = chainByLevel.get(level);
      if (!expected || normalizeCode(expected.code) !== normalized[header]) {
        errors.push(makeRowIssue({
          code: 'INVALID_GEOGRAPHY_HIERARCHY',
          field: header,
          message: `${level} does not match the selected geography hierarchy`,
        }));
      }
    }
    const inActorScope = await isGeographyAllowedForActor({ req, geography: deepestGeography, transaction });
    if (!inActorScope) {
      errors.push(makeRowIssue({
        code: 'OUTSIDE_ADMIN_SCOPE',
        field: 'ward_code',
        message: 'Row is outside the authenticated admin scope',
      }));
    }
  }

  let site = null;
  if (normalized.site_code) {
    site = references.facilitiesByCode.get(normalized.site_code) || null;
    if (!site) {
      errors.push(makeRowIssue({
        code: 'INVALID_SITE',
        field: 'site_code',
        message: 'Site code was not found',
      }));
    } else if (deepestGeography) {
      const facilityGeoId = site.ward_geography_id || site.zone_geography_id || site.geography_id || null;
      if (facilityGeoId && String(facilityGeoId) !== String(deepestGeography.id)) {
        const siteGeography = await Geography.findByPk(facilityGeoId, {
          attributes: ['id', 'parent_id'],
          transaction,
        });
        const siteAllowed = siteGeography
          ? await isGeographyAllowedForActor({ req, geography: siteGeography, transaction })
          : false;
        if (!siteAllowed) {
          errors.push(makeRowIssue({
            code: 'INVALID_SITE_SCOPE',
            field: 'site_code',
            message: 'Site is outside the selected geography scope',
          }));
        }
      }
    }
  }

  if (normalized.shift_code) {
    warnings.push(makeRowIssue({
      code: 'SHIFT_NOT_SUPPORTED',
      field: 'shift_code',
      message: 'Shift assignments are not configured in this tenant and will be ignored',
      severity: 'warning',
    }));
  }

  let supervisor = null;
  if (normalized.supervisor_employee_code) {
    supervisor = references.supervisorsByEmployeeCode.get(normalized.supervisor_employee_code) || null;
    if (!supervisor) {
      errors.push(makeRowIssue({
        code: 'INVALID_SUPERVISOR',
        field: 'supervisor_employee_code',
        message: 'Supervisor employee code was not found in this tenant',
      }));
    }
  }

  const loginIdentifier = deriveIdentifier(normalized);
  if (!loginIdentifier.value) {
    errors.push(makeRowIssue({
      code: 'LOGIN_IDENTIFIER_MISSING',
      field: 'mobile_number',
      message: 'At least one login identifier is required: mobile, email, or employee code',
    }));
  }

  const hasDuplicateIssue = errors.some((issue) => issue.code === 'DUPLICATE_EMPLOYEE_CODE_IN_FILE');
  return {
    rowNumber,
    employeeCode: normalized.employee_code,
    normalizedPayload: normalized,
    status: hasDuplicateIssue ? 'DUPLICATE' : errors.length > 0 ? 'INVALID' : 'VALID',
    errors,
    warnings,
    resolved: {
      geographyId: deepestGeography?.id || null,
      siteId: site?.id || null,
      supervisorUserId: supervisor?.id || null,
      loginIdentifier,
    },
  };
};

const mapJobRowResponse = (row) => {
  const validationErrors = Array.isArray(row.validation_errors?.errors) ? row.validation_errors.errors : [];
  const warnings = Array.isArray(row.validation_errors?.warnings) ? row.validation_errors.warnings : [];
  return {
    rowNumber: row.row_number,
    employeeCode: row.employee_code,
    status: row.status,
    normalizedPayload: row.normalized_payload,
    errors: validationErrors,
    warnings,
    createdWorkerId: row.created_worker_id || null,
    createdUserId: row.created_user_id || null,
    loginIdentifier: row.validation_errors?.loginIdentifier || null,
    accountProvisioningStatus: row.validation_errors?.accountProvisioningStatus || null,
  };
};

const mapJobResponse = async (job, { includeRows = false } = {}) => {
  const payload = {
    id: job.id,
    tenantId: job.tenant_id,
    uploadedBy: job.uploaded_by,
    originalFileName: job.original_file_name,
    fileChecksum: job.file_checksum,
    totalRows: job.total_rows,
    validRows: job.valid_rows,
    invalidRows: job.invalid_rows,
    duplicateRows: job.duplicate_rows,
    warningRows: job.warning_rows,
    createdRows: job.created_rows,
    failedRows: job.failed_rows,
    status: job.status,
    summary: job.summary || {},
    startedAt: job.started_at,
    completedAt: job.completed_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
  if (includeRows) {
    const rows = await WorkerImportRow.findAll({
      where: { import_job_id: job.id },
      order: [['row_number', 'ASC']],
    });
    payload.rows = rows.map(mapJobRowResponse);
  }
  return payload;
};

const persistValidationResults = async ({ req, file, references, validationRows }) => {
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
  const duplicateFileCount = await WorkerImportJob.count({
    where: {
      tenant_id: req.user.tenantId,
      file_checksum: checksum,
    },
  });
  const summary = summarizeCounts(validationRows);
  const job = await WorkerImportJob.create({
    tenant_id: req.user.tenantId,
    uploaded_by: req.user.id,
    uploader_scope_type: req.user.scopeLevel || null,
    uploader_scope_id: req.user.scopeId || null,
    original_file_name: file.originalname || 'workers.csv',
    file_checksum: checksum,
    total_rows: summary.total,
    valid_rows: summary.valid,
    invalid_rows: summary.invalid,
    duplicate_rows: summary.duplicate,
    warning_rows: summary.warnings,
    status: JOB_STATUSES.VALIDATED,
    started_at: new Date(),
    completed_at: new Date(),
    summary: {
      duplicateUploadDetected: duplicateFileCount > 0,
      duplicateUploadCount: duplicateFileCount,
      rowLimit: IMPORT_ROW_LIMIT,
    },
  });

  if (validationRows.length > 0) {
    await WorkerImportRow.bulkCreate(
      validationRows.map((row) => ({
        import_job_id: job.id,
        row_number: row.rowNumber,
        employee_code: row.employeeCode || null,
        normalized_payload: row.normalizedPayload,
        status: row.status,
        validation_errors: {
          errors: row.errors,
          warnings: row.warnings,
          resolved: row.resolved,
          loginIdentifier: row.resolved.loginIdentifier || null,
        },
      }))
    );
  }

  await createAuditLog({
    req,
    action: 'worker.import.validation_completed',
    entityType: 'worker_import_job',
    entityId: job.id,
    tenantId: req.user.tenantId,
    details: {
      totalRows: summary.total,
      validRows: summary.valid,
      invalidRows: summary.invalid,
    },
  });

  return job;
};

const downloadTemplate = async (req) => {
  const prefill = await resolveScopePrefill(req);
  const sampleRow = IMPORT_TEMPLATE_HEADERS.map((header) => prefill[header] || '');
  const csv = stringifyCsv([IMPORT_TEMPLATE_HEADERS, sampleRow]);
  await createAuditLog({
    req,
    action: 'worker.import.template_downloaded',
    entityType: 'worker_import_job',
    tenantId: req.user.tenantId,
    details: { scopeLevel: req.user.scopeLevel || null },
  });
  return {
    fileName: 'worker-import-template.csv',
    contentType: 'text/csv',
    content: csv,
  };
};

const validateImportFile = async (req) => {
  if (!req.file) {
    throw new AppError('CSV file is required', 400, { code: 'FILE_REQUIRED' });
  }
  try {
    if ((req.file.size || 0) > IMPORT_FILE_SIZE_LIMIT_BYTES) {
      throw new AppError('CSV file exceeds allowed size', 400, { code: 'FILE_TOO_LARGE' });
    }

    const content = fs.readFileSync(req.file.path, 'utf8');
    const csvRows = parseCsvText(content);
    if (csvRows.length === 0) {
      throw new AppError('CSV file is empty', 400, { code: 'EMPTY_FILE' });
    }
    const headers = csvRows[0].map((value) => String(value || '').trim());
    const duplicateHeaders = headers.filter((value, index) => headers.indexOf(value) !== index);
    if (duplicateHeaders.length > 0) {
      throw new AppError('Duplicate CSV headers are not allowed', 400, {
        code: 'DUPLICATE_HEADERS',
        details: { headers: [...new Set(duplicateHeaders)] },
      });
    }
    const missingHeaders = IMPORT_TEMPLATE_HEADERS.filter((header) => !headers.includes(header));
    if (missingHeaders.length > 0) {
      throw new AppError('CSV is missing required columns', 400, {
        code: 'MISSING_HEADERS',
        details: { headers: missingHeaders },
      });
    }

    const dataRows = csvRows.slice(1).map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    );
    if (dataRows.length > IMPORT_ROW_LIMIT) {
      throw new AppError('CSV exceeds maximum row count', 400, {
        code: 'ROW_LIMIT_EXCEEDED',
        details: { maxRows: IMPORT_ROW_LIMIT },
      });
    }

    const fileDuplicateEmployeeCodes = new Set();
    const seenEmployeeCodes = new Set();
    for (const rawRow of dataRows) {
      const employeeCode = normalizeCode(rawRow.employee_code);
      if (!employeeCode) continue;
      if (seenEmployeeCodes.has(employeeCode)) fileDuplicateEmployeeCodes.add(employeeCode);
      seenEmployeeCodes.add(employeeCode);
    }

    const references = await loadImportReferenceData({
      tenantId: req.user.tenantId,
      rows: dataRows,
    });

    const validationRows = [];
    for (let index = 0; index < dataRows.length; index += 1) {
      validationRows.push(
        await validateRow({
          req,
          row: dataRows[index],
          rowNumber: index + 2,
          fileDuplicateEmployeeCodes,
          references,
        })
      );
    }

    const job = await persistValidationResults({
      req,
      file: req.file,
      references,
      validationRows,
    });

    return {
      importJobId: job.id,
      summary: summarizeCounts(validationRows),
      duplicateUploadDetected: Boolean(job.summary?.duplicateUploadDetected),
      rows: validationRows,
    };
  } finally {
    await removeTempFile(req.file?.path).catch(() => null);
  }
};

const resolveJobForActor = async ({ req, importJobId, includeRows = false, transaction = null }) => {
  const job = await WorkerImportJob.findByPk(importJobId, { transaction });
  if (!job) {
    throw new AppError('Import job not found', 404, { code: 'IMPORT_JOB_NOT_FOUND' });
  }
  if (!req.user?.isSuperAdmin && String(job.tenant_id) !== String(req.user?.tenantId || '')) {
    throw new AppError('Import job is outside your tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return includeRows ? mapJobResponse(job, { includeRows: true }) : job;
};

const createWorkerFromImportRow = async ({ req, jobId, row, references, mode, transaction }) => {
  const payload = row.normalized_payload || {};
  const resolved = row.validation_errors?.resolved || {};
  const identifier = row.validation_errors?.loginIdentifier || deriveIdentifier(payload);
  const fullName = buildFullName(payload);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await PlatformUser.create(
    {
      tenant_id: req.user.tenantId,
      geography_id: resolved.geographyId || null,
      user_id_code: identifier.kind === 'employee_code' ? payload.employee_code : null,
      full_name: fullName,
      email: payload.email || null,
      phone: payload.mobile_number || null,
      employee_code: payload.employee_code,
      status: 'active',
      must_change_password: true,
      password_hash: passwordHash,
      auth_provider: 'local',
      metadata: {
        workerProfile: {
          firstName: payload.first_name || null,
          middleName: payload.middle_name || null,
          lastName: payload.last_name || null,
          dateOfBirth: payload.date_of_birth || null,
          gender: payload.gender || null,
          workerType: payload.worker_type || null,
          employmentType: payload.employment_type || null,
          joiningDate: payload.joining_date || null,
          preferredLanguage: payload.preferred_language || null,
        },
        activation: {
          loginIdentifier: identifier,
          mustSetPassword: true,
          importedByJobId: jobId,
          mode,
        },
      },
    },
    { transaction }
  );

  await UserRole.create(
    {
      user_id: user.id,
      role_id: references.workerRole.id,
      tenant_id: req.user.tenantId,
      geography_id: resolved.geographyId || null,
    },
    { transaction }
  );

  await WorkerAssignment.create(
    {
      tenant_id: req.user.tenantId,
      user_id: user.id,
      geography_id: resolved.geographyId || null,
      facility_id: resolved.siteId || null,
      supervisor_user_id: resolved.supervisorUserId || null,
      assignment_level: resolved.siteId ? 'facility' : resolved.geographyId ? 'geography' : 'tenant',
      assignment_role: 'worker',
      status: 'active',
      created_by_user_id: req.user.id,
      updated_by_user_id: req.user.id,
    },
    { transaction }
  );

  let accountProvisioningStatus = 'DISPLAY_ONLY';
  if (resolved.supervisorUserId || req.user?.id) {
    const recipients = [resolved.supervisorUserId, req.user?.id].filter(Boolean);
    if (recipients.length > 0) {
      await publishNotification({
        recipients,
        eventType: 'worker.account.created',
        title: 'Worker account created',
        body: `Worker account for ${fullName} is ready for first-login password setup.`,
        shortBody: `Worker account created for ${payload.employee_code || fullName}`,
        entityType: 'platform_user',
        entityId: user.id,
        tenantId: req.user.tenantId,
        createdByUserId: req.user.id,
        metadata: {
          employeeCode: payload.employee_code,
        },
      });
      accountProvisioningStatus = 'ADMIN_NOTIFIED';
    }
  }

  await createAuditLog({
    req,
    action: 'worker.import.worker_created',
    entityType: 'platform_user',
    entityId: user.id,
    tenantId: req.user.tenantId,
    details: {
      importJobId: jobId,
      employeeCode: payload.employee_code,
    },
  });
  await createAuditLog({
    req,
    action: 'worker.import.account_provisioned',
    entityType: 'platform_user',
    entityId: user.id,
    tenantId: req.user.tenantId,
    details: {
      importJobId: jobId,
      accountProvisioningStatus,
    },
  });

  return {
    user,
    temporaryPassword,
    accountProvisioningStatus,
    username: identifier.value,
  };
};

const confirmImport = async (req) => {
  const importJobId = req.params.importJobId;
  const mode = String(req.body?.mode || 'VALID_ROWS_ONLY').trim().toUpperCase();
  if (!['VALID_ROWS_ONLY', 'ALL_OR_NOTHING'].includes(mode)) {
    throw new AppError('Invalid import mode', 400, { code: 'INVALID_IMPORT_MODE' });
  }

  return sequelize.transaction(async (transaction) => {
    const job = await WorkerImportJob.findByPk(importJobId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!job) {
      throw new AppError('Import job not found', 404, { code: 'IMPORT_JOB_NOT_FOUND' });
    }
    if (!req.user?.isSuperAdmin && String(job.tenant_id) !== String(req.user?.tenantId || '')) {
      throw new AppError('Import job is outside your tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    if ([JOB_STATUSES.COMPLETED, JOB_STATUSES.PARTIALLY_COMPLETED].includes(job.status)) {
      const response = await mapJobResponse(job, { includeRows: true });
      return {
        ...response,
        alreadyConfirmed: true,
      };
    }

    await job.update({
      status: JOB_STATUSES.IMPORTING,
      started_at: job.started_at || new Date(),
      updated_at: new Date(),
    }, { transaction });

    const rows = await WorkerImportRow.findAll({
      where: { import_job_id: importJobId },
      order: [['row_number', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const selectedRows = rows.filter((row) => String(row.status).toUpperCase() === 'VALID');
    const invalidRows = rows.filter((row) => String(row.status).toUpperCase() !== 'VALID');
    if (mode === 'ALL_OR_NOTHING' && invalidRows.length > 0) {
      throw new AppError('Invalid rows must be resolved before all-or-nothing import', 409, {
        code: 'INVALID_ROWS_PRESENT',
      });
    }

    const references = await loadImportReferenceData({
      tenantId: req.user.tenantId,
      rows: selectedRows.map((row) => row.normalized_payload || {}),
      transaction,
    });

    let createdRows = 0;
    let failedRows = 0;
    let accountNotificationsSent = 0;
    let accountNotificationsFailed = 0;
    const temporaryCredentials = [];

    for (const row of selectedRows) {
      try {
        const result = await createWorkerFromImportRow({
          req,
          jobId: importJobId,
          row,
          references,
          mode,
          transaction,
        });
        createdRows += 1;
        if (result.accountProvisioningStatus === 'ADMIN_NOTIFIED' || result.accountProvisioningStatus === 'DISPLAY_ONLY') {
          accountNotificationsSent += 1;
        } else {
          accountNotificationsFailed += 1;
        }
        temporaryCredentials.push({
          rowNumber: row.row_number,
          employeeCode: row.employee_code || null,
          workerId: result.user.id,
          username: result.username,
          temporaryPassword: result.temporaryPassword,
        });
        await row.update({
          status: 'IMPORTED',
          created_worker_id: result.user.id,
          created_user_id: result.user.id,
          validation_errors: {
            ...(row.validation_errors || {}),
            accountProvisioningStatus: result.accountProvisioningStatus,
            username: result.username,
            workerCreationStatus: 'CREATED',
            accountCreationStatus: 'CREATED',
          },
          updated_at: new Date(),
        }, { transaction });
      } catch (error) {
        failedRows += 1;
        if (mode === 'ALL_OR_NOTHING') throw error;
        await row.update({
          status: 'FAILED',
          validation_errors: {
            ...(row.validation_errors || {}),
            importError: {
              code: error.code || 'IMPORT_FAILED',
              message: error.message,
            },
            workerCreationStatus: 'FAILED',
            accountCreationStatus: 'FAILED',
          },
          updated_at: new Date(),
        }, { transaction });
      }
    }

    const finalStatus = failedRows > 0 ? JOB_STATUSES.PARTIALLY_COMPLETED : JOB_STATUSES.COMPLETED;
    await job.update({
      status: finalStatus,
      created_rows: createdRows,
      failed_rows: failedRows + invalidRows.length,
      completed_at: new Date(),
      updated_at: new Date(),
      summary: {
        ...(job.summary || {}),
        mode,
        accountNotificationsSent,
        accountNotificationsFailed,
      },
    }, { transaction });

    await createAuditLog({
      req,
      action: 'worker.import.confirmed',
      entityType: 'worker_import_job',
      entityId: job.id,
      tenantId: req.user.tenantId,
      details: {
        mode,
        createdRows,
        failedRows,
      },
    });

    const response = await mapJobResponse(job, { includeRows: true });
    return {
      ...response,
      result: {
        workersCreated: createdRows,
        accountsCreated: createdRows,
        failedRows,
        accountNotificationsSent,
        accountNotificationsFailed,
      },
      temporaryCredentials,
    };
  });
};

const listHistory = async (req) => {
  const rows = await WorkerImportJob.findAll({
    where: req.user?.isSuperAdmin && req.query.tenantId
      ? { tenant_id: req.query.tenantId }
      : { tenant_id: req.user.tenantId },
    order: [['created_at', 'DESC']],
    limit: 50,
  });
  return Promise.all(rows.map((row) => mapJobResponse(row)));
};

const getJobById = async (req) => {
  const payload = await resolveJobForActor({
    req,
    importJobId: req.params.importJobId,
    includeRows: true,
  });
  return payload;
};

const downloadResultsCsv = async (req) => {
  const payload = await resolveJobForActor({
    req,
    importJobId: req.params.importJobId,
    includeRows: true,
  });
  const rows = [
    [
      'row_number',
      'employee_code',
      'worker_id',
      'username',
      'worker_creation_status',
      'account_creation_status',
      'account_provisioning_status',
      'error_code',
      'error_message',
    ],
  ];
  for (const row of payload.rows || []) {
    const importError = row.normalizedPayload?.importError || row.importError || row.errors?.[0] || null;
    rows.push([
      row.rowNumber,
      row.employeeCode || '',
      row.createdWorkerId || '',
      row.loginIdentifier?.value || row.username || '',
      row.createdWorkerId ? 'CREATED' : row.status,
      row.createdUserId ? 'CREATED' : row.status,
      row.accountProvisioningStatus || '',
      importError?.code || row.errors?.[0]?.code || '',
      importError?.message || row.errors?.[0]?.message || '',
    ]);
  }
  return {
    fileName: `worker-import-results-${payload.id}.csv`,
    contentType: 'text/csv',
    content: stringifyCsv(rows),
  };
};

module.exports = {
  IMPORT_TEMPLATE_HEADERS,
  downloadTemplate,
  validateImportFile,
  confirmImport,
  listHistory,
  getJobById,
  downloadResultsCsv,
};
