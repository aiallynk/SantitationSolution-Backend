'use strict';

const { Op } = require('sequelize');
const { TenantQuotaNotification } = require('../../models');
const { publishNotification } = require('../notifications/notification.service');
const {
  resolveTenantAdminIds,
  resolvePlatformAdminIds,
} = require('../notifications/notification.recipientResolver');

// ─── Quota status levels ───────────────────────────────────────────────────────

const QUOTA_STATUS = {
  UNLIMITED: 'unlimited',
  HEALTHY: 'healthy',
  WARNING_75: 'warning_75',
  WARNING_90: 'warning_90',
  EXHAUSTED: 'exhausted',
};

const THRESHOLDS = [75, 90, 100];

// ─── Calculate single resource quota ──────────────────────────────────────────

function calcResourceQuota({ resource, limitEnabled, limit, used, hardBlock = false, globalEnabled = true }) {
  if (!globalEnabled || !limitEnabled || limit == null || limit <= 0) {
    return {
      resource,
      enabled: false,
      limit: null,
      used: used ?? 0,
      usedPercentage: null,
      status: QUOTA_STATUS.UNLIMITED,
      canProceed: true,
      hardBlock: false,
      message: null,
    };
  }

  const usedNum = Number(used) || 0;
  const limitNum = Number(limit);
  const pct = Math.round((usedNum / limitNum) * 10000) / 100;

  let status = QUOTA_STATUS.HEALTHY;
  if (pct >= 100) status = QUOTA_STATUS.EXHAUSTED;
  else if (pct >= 90) status = QUOTA_STATUS.WARNING_90;
  else if (pct >= 75) status = QUOTA_STATUS.WARNING_75;

  const canProceed = status !== QUOTA_STATUS.EXHAUSTED || !hardBlock;

  const messages = {
    [QUOTA_STATUS.HEALTHY]: null,
    [QUOTA_STATUS.WARNING_75]: `${resourceLabel(resource)} usage has crossed 75% of the assigned quota.`,
    [QUOTA_STATUS.WARNING_90]: `${resourceLabel(resource)} usage is at 90%. Approaching the limit.`,
    [QUOTA_STATUS.EXHAUSTED]: hardBlock
      ? `${resourceLabel(resource)} quota exhausted. New operations are blocked until the limit is increased.`
      : `${resourceLabel(resource)} quota exhausted. Contact Super Admin to increase the limit.`,
  };

  return {
    resource,
    enabled: true,
    limit: limitNum,
    used: usedNum,
    usedPercentage: pct,
    status,
    canProceed,
    hardBlock,
    message: messages[status],
  };
}

function resourceLabel(resource) {
  const labels = {
    storage: 'Storage',
    ai_tokens: 'AI tokens',
    ai_requests: 'AI requests',
    users: 'User',
    toilets: 'Toilet',
    facilities: 'Facility',
    devices: 'Device',
    inspections: 'Inspection',
  };
  return labels[resource] || resource;
}

// ─── Build full quota status from limits + usage ───────────────────────────────

function buildQuotaStatus(limits, usage) {
  const g = limits?.limitsEnabled ?? false;
  const u = usage || {};

  return {
    limitsEnabled: g,
    storage: calcResourceQuota({
      resource: 'storage',
      limitEnabled: limits?.storage?.enabled,
      limit: limits?.storage?.limitBytes,
      used: u.storageUsedBytes,
      hardBlock: limits?.storage?.hardBlock,
      globalEnabled: g,
    }),
    aiTokens: calcResourceQuota({
      resource: 'ai_tokens',
      limitEnabled: limits?.aiTokens?.enabled,
      limit: limits?.aiTokens?.limit,
      used: u.aiTokens30d,
      hardBlock: limits?.aiTokens?.hardBlock,
      globalEnabled: g,
    }),
    aiRequests: calcResourceQuota({
      resource: 'ai_requests',
      limitEnabled: limits?.aiRequests?.enabled,
      limit: limits?.aiRequests?.limit,
      used: u.aiRequests30d,
      hardBlock: limits?.aiRequests?.hardBlock,
      globalEnabled: g,
    }),
    users: calcResourceQuota({
      resource: 'users',
      limitEnabled: limits?.users?.enabled,
      limit: limits?.users?.limit,
      used: u.usersCount,
      hardBlock: limits?.users?.hardBlock,
      globalEnabled: g,
    }),
    toilets: calcResourceQuota({
      resource: 'toilets',
      limitEnabled: limits?.toilets?.enabled,
      limit: limits?.toilets?.limit,
      used: u.toiletsCount,
      hardBlock: limits?.toilets?.hardBlock,
      globalEnabled: g,
    }),
    facilities: calcResourceQuota({
      resource: 'facilities',
      limitEnabled: limits?.facilities?.enabled,
      limit: limits?.facilities?.limit,
      used: u.facilitiesCount,
      hardBlock: limits?.facilities?.hardBlock,
      globalEnabled: g,
    }),
    devices: calcResourceQuota({
      resource: 'devices',
      limitEnabled: limits?.devices?.enabled,
      limit: limits?.devices?.limit,
      used: u.devicesCount,
      hardBlock: limits?.devices?.hardBlock,
      globalEnabled: g,
    }),
    inspections: calcResourceQuota({
      resource: 'inspections',
      limitEnabled: limits?.inspections?.enabled,
      limit: limits?.inspections?.limit,
      used: u.inspections30d,
      hardBlock: limits?.inspections?.hardBlock,
      globalEnabled: g,
    }),
  };
}

// ─── Quota enforcement check (called at resource creation points) ──────────────

async function checkQuota({ tenantId, resource, limits, usage }) {
  const quota = buildQuotaStatus(limits, usage);
  const resourceQuota = quota[resource];
  if (!resourceQuota) return { canProceed: true };

  if (!resourceQuota.canProceed) {
    return {
      canProceed: false,
      status: resourceQuota.status,
      message: resourceQuota.message,
      used: resourceQuota.used,
      limit: resourceQuota.limit,
      usedPercentage: resourceQuota.usedPercentage,
    };
  }

  // Trigger threshold notifications asynchronously (don't block the main request)
  if (resourceQuota.enabled && resourceQuota.status !== QUOTA_STATUS.HEALTHY && resourceQuota.status !== QUOTA_STATUS.UNLIMITED) {
    setImmediate(() => {
      triggerThresholdNotification({ tenantId, resource, quota: resourceQuota, notificationPrefs: limits?.notifications }).catch(() => {});
    });
  }

  return { canProceed: true, status: resourceQuota.status };
}

// ─── Threshold notification (with dedupe) ─────────────────────────────────────

async function triggerThresholdNotification({ tenantId, resource, quota, notificationPrefs }) {
  if (!quota.enabled || quota.status === QUOTA_STATUS.HEALTHY || quota.status === QUOTA_STATUS.UNLIMITED) return;

  const pct = quota.usedPercentage;
  const threshold = pct >= 100 ? 100 : pct >= 90 ? 90 : 75;

  const prefs = notificationPrefs || {};
  if (threshold === 75 && !prefs.warning75) return;
  if (threshold === 90 && !prefs.warning90) return;
  if (threshold === 100 && !prefs.exhausted) return;

  // Dedupe: don't re-send if already sent for this tenant+resource+threshold since last reset
  const existing = await TenantQuotaNotification.findOne({
    where: {
      tenant_id: tenantId,
      resource,
      threshold,
      reset_at: null,
    },
  });
  if (existing) return;

  // Resolve recipients
  const recipients = [];
  if (prefs.notifyTenantAdmin !== false) {
    const tenantAdminIds = await resolveTenantAdminIds({ tenantId }).catch(() => []);
    recipients.push(...tenantAdminIds);
  }
  if (prefs.notifySuperAdmin !== false) {
    const platformAdminIds = await resolvePlatformAdminIds().catch(() => []);
    recipients.push(...platformAdminIds);
  }

  const label = resourceLabel(resource);
  const usedFormatted = formatQuotaValue(resource, quota.used);
  const limitFormatted = formatQuotaValue(resource, quota.limit);

  const titleMap = {
    75: `${label} quota at 75%`,
    90: `${label} quota at 90%`,
    100: `${label} quota exhausted`,
  };
  const bodyMap = {
    75: `Tenant has used ${pct.toFixed(1)}% of the assigned ${label.toLowerCase()} quota (${usedFormatted} of ${limitFormatted}).`,
    90: `Tenant has used ${pct.toFixed(1)}% of the assigned ${label.toLowerCase()} quota (${usedFormatted} of ${limitFormatted}). Please increase the limit or take action.`,
    100: `Tenant ${label.toLowerCase()} quota is exhausted (${usedFormatted} of ${limitFormatted}). New operations may be blocked depending on tenant policy.`,
  };

  const dedupeKey = `tenant_quota:${tenantId}:${resource}:${threshold}`;

  // Save notification record first (for dedupe)
  await TenantQuotaNotification.create({
    tenant_id: tenantId,
    resource,
    threshold,
    usage_percentage: pct,
    limit_value: quota.limit,
    used_value: quota.used,
    notification_sent_at: new Date(),
    recipients: recipients,
    status: 'sent',
  });

  if (recipients.length > 0) {
    await publishNotification({
      recipients,
      eventType: `tenant_quota_${threshold}`,
      notificationType: 'system',
      priority: threshold === 100 ? 'HIGH' : threshold === 90 ? 'HIGH' : 'MEDIUM',
      title: titleMap[threshold],
      body: bodyMap[threshold],
      shortBody: bodyMap[threshold],
      entityType: 'tenant',
      entityId: tenantId,
      tenantId,
      dedupeKey,
      severity: threshold === 100 ? 'critical' : threshold === 90 ? 'high' : 'medium',
      metadata: { resource, threshold, usedPercentage: pct, used: quota.used, limit: quota.limit },
      payload: {
        type: `tenant_quota_${threshold}`,
        tenantId,
        resource,
        threshold,
        usedPercentage: pct,
      },
    }).catch(() => {});
  }
}

// ─── Reset threshold notifications when usage drops below threshold ──────────

async function resetQuotaNotifications({ tenantId, resource, currentPercentage }) {
  const toReset = THRESHOLDS.filter((t) => currentPercentage < t);
  if (toReset.length === 0) return;

  await TenantQuotaNotification.update(
    { reset_at: new Date() },
    {
      where: {
        tenant_id: tenantId,
        resource,
        threshold: { [Op.in]: toReset },
        reset_at: null,
      },
    }
  );
}

// ─── Trigger quota check after recalculation ──────────────────────────────────

async function auditAllQuotasForTenant({ tenantId, limits, usage }) {
  if (!limits?.limitsEnabled) return;

  const quota = buildQuotaStatus(limits, usage);
  const resources = ['storage', 'aiTokens', 'aiRequests', 'users', 'toilets', 'facilities', 'devices', 'inspections'];
  const resourceKeys = {
    storage: 'storage',
    aiTokens: 'ai_tokens',
    aiRequests: 'ai_requests',
    users: 'users',
    toilets: 'toilets',
    facilities: 'facilities',
    devices: 'devices',
    inspections: 'inspections',
  };

  await Promise.allSettled(
    resources.map(async (res) => {
      const q = quota[res];
      const resKey = resourceKeys[res];
      if (!q || !q.enabled) return;

      if (q.status === QUOTA_STATUS.HEALTHY || q.status === QUOTA_STATUS.UNLIMITED) {
        await resetQuotaNotifications({ tenantId, resource: resKey, currentPercentage: q.usedPercentage ?? 0 });
      } else {
        await triggerThresholdNotification({ tenantId, resource: resKey, quota: q, notificationPrefs: limits?.notifications });
      }
    })
  );
}

// ─── Format quota values for human-readable messages ─────────────────────────

function formatQuotaValue(resource, value) {
  if (value == null) return '—';
  if (resource === 'storage') return formatBytes(value);
  if (resource === 'ai_tokens') return formatTokens(value);
  return Number(value).toLocaleString();
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function formatTokens(v) {
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tokens`;
  return `${n} tokens`;
}

module.exports = {
  buildQuotaStatus,
  calcResourceQuota,
  checkQuota,
  triggerThresholdNotification,
  resetQuotaNotifications,
  auditAllQuotasForTenant,
  QUOTA_STATUS,
};
