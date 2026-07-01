const {
  initializeFirebaseAdmin,
  getFirebaseMessaging,
} = require('../../config/firebase-admin');

const ANDROID_CHANNEL_ID = 'sanitation_alerts';

const ensureFirebaseAdmin = () => {
  const state = initializeFirebaseAdmin();
  return {
    enabled: Boolean(state?.enabled),
    error: state?.error || null,
  };
};

const normalizeData = (payload = {}) => {
  const data = {};
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    data[String(key)] = typeof value === 'string' ? value : JSON.stringify(value);
  });
  return data;
};

const normalizeImageUrl = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (!/^https?:\/\//i.test(normalized)) return null;
  return normalized;
};

const sendPushBatch = async ({ tokens = [], title = '', body = '', data = {}, imageUrl = null } = {}) => {
  const uniqueTokens = [...new Set((tokens || []).filter(Boolean).map((token) => String(token).trim()))];
  if (uniqueTokens.length === 0) {
    return {
      enabled: true,
      sentCount: 0,
      failedCount: 0,
      responses: [],
    };
  }

  const state = ensureFirebaseAdmin();
  if (!state.enabled) {
    return {
      enabled: false,
      sentCount: 0,
      failedCount: uniqueTokens.length,
      responses: uniqueTokens.map((token) => ({
        token,
        success: false,
        errorCode: 'FCM_DISABLED',
        errorMessage: state.error || 'FCM is disabled',
      })),
    };
  }

  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return {
      enabled: false,
      sentCount: 0,
      failedCount: uniqueTokens.length,
      responses: uniqueTokens.map((token) => ({
        token,
        success: false,
        errorCode: 'FCM_DISABLED',
        errorMessage: state.error || 'FCM is disabled',
      })),
    };
  }

  try {
    const normalizedImageUrl = normalizeImageUrl(imageUrl);
    const result = await messaging.sendEachForMulticast({
      tokens: uniqueTokens,
      notification: {
        title: String(title || '').slice(0, 120),
        body: String(body || '').slice(0, 800),
        ...(normalizedImageUrl ? { image: normalizedImageUrl } : {}),
      },
      data: normalizeData(data),
      android: {
        priority: 'high',
        notification: {
          channelId: ANDROID_CHANNEL_ID,
          sound: 'default',
          ...(normalizedImageUrl ? { imageUrl: normalizedImageUrl } : {}),
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            sound: 'default',
            'content-available': 1,
            ...(normalizedImageUrl ? { 'mutable-content': 1 } : {}),
          },
        },
        ...(normalizedImageUrl
          ? {
              fcm_options: {
                image: normalizedImageUrl,
              },
            }
          : {}),
      },
      webpush: {
        headers: {
          Urgency: 'high',
        },
        ...(normalizedImageUrl
          ? {
              notification: {
                image: normalizedImageUrl,
              },
            }
          : {}),
      },
    });

    const responses = result.responses.map((entry, index) => ({
      token: uniqueTokens[index],
      success: Boolean(entry.success),
      messageId: entry.messageId || null,
      errorCode: entry.error?.code || null,
      errorMessage: entry.error?.message || null,
    }));

    return {
      enabled: true,
      sentCount: result.successCount || 0,
      failedCount: result.failureCount || 0,
      responses,
    };
  } catch (error) {
    return {
      enabled: true,
      sentCount: 0,
      failedCount: uniqueTokens.length,
      responses: uniqueTokens.map((token) => ({
        token,
        success: false,
        errorCode: error?.code || 'FCM_SEND_FAILED',
        errorMessage: error?.message || 'FCM send failed',
      })),
    };
  }
};

const sendPushSingle = async ({
  token,
  title = '',
  body = '',
  data = {},
} = {}) => {
  const result = await sendPushBatch({
    tokens: token ? [token] : [],
    title,
    body,
    data,
  });
  const firstResponse = Array.isArray(result.responses) ? result.responses[0] : null;
  return {
    enabled: result.enabled,
    sentCount: result.sentCount,
    failedCount: result.failedCount,
    response: firstResponse,
    responses: result.responses,
  };
};

module.exports = {
  ensureFirebaseAdmin,
  sendPushBatch,
  sendPushSingle,
};
