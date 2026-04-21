const fs = require('fs');
const path = require('path');
const { logger } = require('../core/logging/logger');

let firebaseAdmin = null;
let initializationState = {
  initialized: false,
  enabled: false,
  error: null,
  projectId: null,
};

const asText = (value) => String(value ?? '').trim();

const parseJsonSafely = (value) => {
  const raw = asText(value);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
};

const normalizePrivateKey = (value) => {
  let raw = asText(value);
  if (!raw) {
    return '';
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw.replace(/\\n/g, '\n');
};

const toServiceAccountShape = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const projectId = asText(
    value.project_id || value.projectId || process.env.FIREBASE_PROJECT_ID
  );
  const clientEmail = asText(
    value.client_email || value.clientEmail || process.env.FIREBASE_CLIENT_EMAIL
  );
  const privateKey = normalizePrivateKey(
    value.private_key || value.privateKey || process.env.FIREBASE_PRIVATE_KEY
  );
  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }
  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
  };
};

const loadServiceAccountFromFile = () => {
  const configuredPath =
    asText(process.env.FIREBASE_SERVICE_ACCOUNT_PATH) ||
    asText(process.env.FIREBASE_SERVICE_ACCOUNT_FILE);
  if (!configuredPath) {
    return null;
  }
  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(absolutePath, 'utf8');
    return toServiceAccountShape(parseJsonSafely(raw));
  } catch (_) {
    return null;
  }
};

const loadServiceAccountFromInlineJson = () => {
  const inlineJson = asText(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!inlineJson) {
    return null;
  }
  return toServiceAccountShape(parseJsonSafely(inlineJson));
};

const loadServiceAccountFromBase64 = () => {
  const encoded = asText(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64);
  if (!encoded) {
    return null;
  }
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return toServiceAccountShape(parseJsonSafely(decoded));
  } catch (_) {
    return null;
  }
};

const loadServiceAccountFromDiscreteEnv = () =>
  toServiceAccountShape({
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY,
  });

const resolveServiceAccount = () =>
  loadServiceAccountFromDiscreteEnv() ||
  loadServiceAccountFromFile() ||
  loadServiceAccountFromInlineJson() ||
  loadServiceAccountFromBase64();

const initializeFirebaseAdmin = () => {
  if (initializationState.initialized) {
    return initializationState;
  }

  initializationState = {
    initialized: true,
    enabled: false,
    error: null,
    projectId: null,
  };

  let admin = null;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    admin = require('firebase-admin');
  } catch (error) {
    initializationState.error = 'firebase-admin package is not available';
    logger.warn('Firebase Admin unavailable. Push delivery disabled.', {
      error: initializationState.error,
    });
    return initializationState;
  }

  const serviceAccount = resolveServiceAccount();
  if (!serviceAccount) {
    initializationState.error =
      'Firebase credentials missing. Set FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY or FIREBASE_SERVICE_ACCOUNT_PATH.';
    logger.warn('Firebase Admin credentials are not configured. Push delivery disabled.');
    return initializationState;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
          privateKey: serviceAccount.private_key,
        }),
        projectId: serviceAccount.project_id,
      });
    }
    firebaseAdmin = admin;
    initializationState.enabled = true;
    initializationState.projectId = serviceAccount.project_id;
    logger.info('Firebase Admin initialized successfully.', {
      projectId: initializationState.projectId,
    });
    return initializationState;
  } catch (error) {
    initializationState.error =
      error?.message || 'Failed to initialize Firebase Admin';
    logger.warn('Firebase Admin initialization failed. Push delivery disabled.', {
      error: initializationState.error,
    });
    return initializationState;
  }
};

const getFirebaseAdmin = () => {
  initializeFirebaseAdmin();
  return firebaseAdmin;
};

const getFirebaseMessaging = () => {
  const state = initializeFirebaseAdmin();
  if (!state.enabled || !firebaseAdmin) {
    return null;
  }
  try {
    return firebaseAdmin.messaging();
  } catch (_) {
    return null;
  }
};

module.exports = {
  initializeFirebaseAdmin,
  getFirebaseAdmin,
  getFirebaseMessaging,
};

