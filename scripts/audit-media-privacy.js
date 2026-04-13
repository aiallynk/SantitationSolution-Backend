#!/usr/bin/env node

require('../src/config/env');

const { Op } = require('sequelize');
const { sequelize, InspectionMedia, Complaint } = require('../src/models');
const { deriveObjectKeyFromUrl } = require('../src/modules/media/mediaUrl.service');
const { normalizeS3ObjectKey } = require('../src/modules/media/s3.service');

const bucket = String(process.env.AWS_S3_BUCKET || '').trim();
const shouldFix = process.argv.includes('--fix');

const startsWith = (value, prefix) =>
  String(value || '').trim().toLowerCase().startsWith(String(prefix || '').toLowerCase());

const toLocator = (value) => {
  if (!bucket) return null;
  const objectKey = deriveObjectKeyFromUrl(value);
  if (!objectKey) return null;
  return `s3://${bucket}/${objectKey}`;
};

const normalizeLocator = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!startsWith(raw, 's3://')) return raw;
  const objectKey = normalizeS3ObjectKey(raw);
  if (!objectKey || !bucket) return raw;
  return `s3://${bucket}/${objectKey}`;
};

const auditInspectionMedia = async () => {
  const rows = await InspectionMedia.findAll({
    attributes: ['id', 'file_url', 'thumbnail_url', 'storage_key'],
    where: {
      [Op.or]: [
        { file_url: { [Op.not]: null } },
        { thumbnail_url: { [Op.not]: null } },
      ],
    },
  });

  let httpFileUrlCount = 0;
  let locatorFileUrlCount = 0;
  let convertedCount = 0;
  let unresolvedHttpCount = 0;

  for (const row of rows) {
    const fileUrl = String(row.file_url || '').trim();
    const thumbnailUrl = String(row.thumbnail_url || '').trim();

    if (startsWith(fileUrl, 'http://') || startsWith(fileUrl, 'https://')) {
      httpFileUrlCount += 1;
    }
    if (startsWith(fileUrl, 's3://')) {
      locatorFileUrlCount += 1;
    }

    if (!shouldFix) {
      continue;
    }

    const updates = {};
    let objectKeyFromAny = null;

    if (startsWith(fileUrl, 'http://') || startsWith(fileUrl, 'https://')) {
      const locator = toLocator(fileUrl);
      if (locator) {
        updates.file_url = locator;
        objectKeyFromAny = deriveObjectKeyFromUrl(fileUrl);
      } else {
        unresolvedHttpCount += 1;
      }
    } else if (startsWith(fileUrl, 's3://')) {
      updates.file_url = normalizeLocator(fileUrl);
      objectKeyFromAny = normalizeS3ObjectKey(fileUrl);
    }

    if (startsWith(thumbnailUrl, 'http://') || startsWith(thumbnailUrl, 'https://')) {
      const locator = toLocator(thumbnailUrl);
      if (locator) {
        updates.thumbnail_url = locator;
        objectKeyFromAny = objectKeyFromAny || deriveObjectKeyFromUrl(thumbnailUrl);
      } else {
        unresolvedHttpCount += 1;
      }
    } else if (startsWith(thumbnailUrl, 's3://')) {
      updates.thumbnail_url = normalizeLocator(thumbnailUrl);
      objectKeyFromAny = objectKeyFromAny || normalizeS3ObjectKey(thumbnailUrl);
    }

    if (!row.storage_key && objectKeyFromAny) {
      updates.storage_key = objectKeyFromAny;
    }

    const hasChanges = Object.entries(updates).some(([key, value]) => {
      const current = row.get(key);
      return String(current || '') !== String(value || '');
    });
    if (!hasChanges) {
      continue;
    }

    await row.update(updates);
    convertedCount += 1;
  }

  return {
    totalRows: rows.length,
    httpFileUrlCount,
    locatorFileUrlCount,
    convertedCount,
    unresolvedHttpCount,
  };
};

const auditComplaints = async () => {
  const rows = await Complaint.findAll({
    attributes: ['id', 'evidence_image_url'],
    where: {
      evidence_image_url: { [Op.not]: null },
    },
  });

  let httpEvidenceCount = 0;
  let locatorEvidenceCount = 0;
  let convertedCount = 0;
  let unresolvedHttpCount = 0;

  for (const row of rows) {
    const url = String(row.evidence_image_url || '').trim();
    if (startsWith(url, 'http://') || startsWith(url, 'https://')) {
      httpEvidenceCount += 1;
    }
    if (startsWith(url, 's3://')) {
      locatorEvidenceCount += 1;
    }

    if (!shouldFix) {
      continue;
    }

    if (startsWith(url, 'http://') || startsWith(url, 'https://')) {
      const locator = toLocator(url);
      if (!locator) {
        unresolvedHttpCount += 1;
        continue;
      }
      if (String(locator) !== String(url)) {
        await row.update({ evidence_image_url: locator });
        convertedCount += 1;
      }
      continue;
    }

    if (startsWith(url, 's3://')) {
      const normalized = normalizeLocator(url);
      if (String(normalized) !== String(url)) {
        await row.update({ evidence_image_url: normalized });
        convertedCount += 1;
      }
    }
  }

  return {
    totalRows: rows.length,
    httpEvidenceCount,
    locatorEvidenceCount,
    convertedCount,
    unresolvedHttpCount,
  };
};

const main = async () => {
  if (!bucket) {
    throw new Error('AWS_S3_BUCKET must be configured before running media privacy audit');
  }

  const inspectionMedia = await auditInspectionMedia();
  const complaints = await auditComplaints();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: shouldFix ? 'fix' : 'audit',
        inspectionMedia,
        complaints,
      },
      null,
      2
    )
  );
};

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error.message,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });

