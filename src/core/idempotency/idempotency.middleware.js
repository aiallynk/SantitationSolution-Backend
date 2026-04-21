const crypto = require('crypto');
const AppError = require('../errors/AppError');
const { IdempotencyKey } = require('../../models');
const { runtimeConfig } = require('../../config/runtime');

const DEFAULT_LOCK_MS = runtimeConfig.idempotency.lockMs;
const DEFAULT_TTL_MS = runtimeConfig.idempotency.ttlMs;
const DEFAULT_RESPONSE_MAX_BYTES = runtimeConfig.idempotency.responseMaxBytes;

const stableStringify = (value) => {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const computeRequestHash = (req) => {
  const hash = crypto.createHash('sha256');
  hash.update(req.method || 'POST');
  hash.update('|');
  hash.update(req.originalUrl || req.path || '');
  hash.update('|');
  hash.update(stableStringify(req.params || {}));
  hash.update('|');
  hash.update(stableStringify(req.query || {}));
  hash.update('|');
  hash.update(stableStringify(req.body || {}));
  return hash.digest('hex');
};

const normalizeHeaderValue = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const resolveScopedKey = ({ tenantId, idempotencyKey }) =>
  `${tenantId || 'platform'}:${idempotencyKey}`;

const estimateJsonSizeBytes = (value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (_) {
    return Number.MAX_SAFE_INTEGER;
  }
};

const withIdempotency = (scope, options = {}) => {
  const scopeName = String(scope || '').trim();
  if (!scopeName) {
    throw new Error('withIdempotency(scope) requires a non-empty scope');
  }

  const lockMs =
    Number.isFinite(Number(options.lockMs)) && Number(options.lockMs) > 0
      ? Number(options.lockMs)
      : DEFAULT_LOCK_MS;
  const ttlMs =
    Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
      ? Number(options.ttlMs)
      : DEFAULT_TTL_MS;
  const storeResponse = options.storeResponse !== false;
  const responseMaxBytes =
    Number.isFinite(Number(options.responseMaxBytes)) && Number(options.responseMaxBytes) > 0
      ? Number(options.responseMaxBytes)
      : DEFAULT_RESPONSE_MAX_BYTES;
  const requireKey = options.requireKey === true;

  return async (req, res, next) => {
    try {
      const idempotencyKey = normalizeHeaderValue(req.header('Idempotency-Key'));
      if (!idempotencyKey) {
        if (requireKey) {
          return next(
            new AppError('Idempotency-Key header is required', 400, {
              code: 'IDEMPOTENCY_KEY_REQUIRED',
            })
          );
        }
        return next();
      }

      const requestHash = computeRequestHash(req);
      const tenantId = req.user?.tenantId || null;
      const scopedKey = resolveScopedKey({ tenantId, idempotencyKey });
      const now = new Date();
      const lockUntil = new Date(now.getTime() + lockMs);

      let record = await IdempotencyKey.findOne({
        where: {
          scope: scopeName,
          idempotency_key: scopedKey,
        },
      });

      if (record) {
        if (record.request_hash && record.request_hash !== requestHash) {
          return next(
            new AppError('Idempotency key cannot be reused with a different request payload', 409, {
              code: 'IDEMPOTENCY_CONFLICT',
            })
          );
        }

        const isExpired =
          record.expires_at && new Date(record.expires_at).getTime() <= now.getTime();
        if (!isExpired && record.response_code && record.response_body) {
          res.setHeader('x-idempotent-replay', 'true');
          return res.status(record.response_code).json(record.response_body);
        }

        if (isExpired) {
          await record.update({
            response_code: null,
            response_body: null,
            expires_at: null,
            updated_at: new Date(),
          });
        }

        if (record.locked_until && new Date(record.locked_until).getTime() > now.getTime()) {
          return next(
            new AppError('A request with this idempotency key is already in progress', 409, {
              code: 'IDEMPOTENCY_IN_PROGRESS',
            })
          );
        }

        await record.update({
          tenant_id: tenantId,
          request_hash: requestHash,
          locked_until: lockUntil,
          updated_at: new Date(),
        });
      } else {
        try {
          record = await IdempotencyKey.create({
            tenant_id: tenantId,
            scope: scopeName,
            idempotency_key: scopedKey,
            request_hash: requestHash,
            locked_until: lockUntil,
            expires_at: new Date(now.getTime() + ttlMs),
          });
        } catch (error) {
          // Handle race on unique(scope, key) by re-reading current record.
          record = await IdempotencyKey.findOne({
            where: {
              scope: scopeName,
              idempotency_key: scopedKey,
            },
          });
          if (!record) {
            throw error;
          }
          if (record.request_hash && record.request_hash !== requestHash) {
            return next(
              new AppError('Idempotency key cannot be reused with a different request payload', 409, {
                code: 'IDEMPOTENCY_CONFLICT',
              })
            );
          }
          const isExpired =
            record.expires_at && new Date(record.expires_at).getTime() <= now.getTime();
          if (!isExpired && record.response_code && record.response_body) {
            res.setHeader('x-idempotent-replay', 'true');
            return res.status(record.response_code).json(record.response_body);
          }
          if (isExpired) {
            await record.update({
              response_code: null,
              response_body: null,
              expires_at: null,
              updated_at: new Date(),
            });
          }
          if (record.locked_until && new Date(record.locked_until).getTime() > now.getTime()) {
            return next(
              new AppError('A request with this idempotency key is already in progress', 409, {
                code: 'IDEMPOTENCY_IN_PROGRESS',
              })
            );
          }
          await record.update({
            tenant_id: tenantId,
            request_hash: requestHash,
            locked_until: lockUntil,
            updated_at: new Date(),
          });
        }
      }

      req.idempotency = {
        scope: scopeName,
        key: scopedKey,
        requestHash,
        recordId: record.id,
      };

      const originalJson = res.json.bind(res);
      let capturedBody = null;
      res.json = (payload) => {
        capturedBody = payload;
        return originalJson(payload);
      };

      res.on('finish', () => {
        if (!req.idempotency?.recordId) {
          return;
        }

        const shouldPersist =
          storeResponse &&
          res.statusCode >= 200 &&
          res.statusCode < 500 &&
          capturedBody !== null &&
          estimateJsonSizeBytes(capturedBody) <= responseMaxBytes;
        const updatePayload = shouldPersist
          ? {
              response_code: res.statusCode,
              response_body: capturedBody,
              locked_until: null,
              expires_at: new Date(Date.now() + ttlMs),
              updated_at: new Date(),
            }
          : {
              locked_until: null,
              updated_at: new Date(),
            };

        IdempotencyKey.update(updatePayload, {
          where: {
            id: req.idempotency.recordId,
          },
        }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error('Failed to persist idempotency response:', error.message);
        });
      });

      return next();
    } catch (error) {
      return next(error);
    }
  };
};

module.exports = {
  withIdempotency,
  computeRequestHash,
};
