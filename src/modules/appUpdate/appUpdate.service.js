const fs = require('fs');
const path = require('path');

const AppError = require('../../core/errors/AppError');
const { runtimeConfig } = require('../../config/runtime');
const { sanitizeText } = require('../../utils/validators');

const VERSION_TOKEN_PATTERN = /^[0-9A-Za-z._-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const resolveAppUpdateConfigPath = () =>
  path.resolve(process.env.APP_UPDATE_CONFIG_PATH || path.join(process.cwd(), 'app-update.json'));

const resolveApkDirectoryPath = () =>
  path.resolve(process.env.APP_UPDATE_APK_DIR || path.join(process.cwd(), 'apk'));

const sanitizeVersionToken = (value, fallback = '') => {
  const normalized = sanitizeText(value, 80).replace(/^v/i, '');
  if (!normalized) {
    return fallback;
  }
  return VERSION_TOKEN_PATTERN.test(normalized) ? normalized : fallback;
};

const sanitizeApkFileName = (value) => {
  const normalized = sanitizeText(value, 200).replace(/[\\/]/g, '').trim();
  if (!normalized || !normalized.toLowerCase().endsWith('.apk')) {
    return '';
  }
  return normalized;
};

const resolvePublicApiBaseUrl = (req) => {
  const configured = String(
    process.env.APP_API_BASE_URL || runtimeConfig.urls.apiPublicBaseUrl || ''
  )
    .trim()
    .replace(/\/+$/, '');
  if (configured) {
    return configured;
  }
  return `${req.protocol}://${req.get('host')}`;
};

const readConfigPayload = () => {
  const configPath = resolveAppUpdateConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new AppError('App update config not found', 503, {
      code: 'APP_UPDATE_CONFIG_NOT_FOUND',
      details: {
        configPath,
      },
    });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    throw new AppError('App update config contains invalid JSON', 500, {
      code: 'APP_UPDATE_CONFIG_INVALID',
      details: {
        configPath,
      },
    });
  }

  const latestVersion = sanitizeVersionToken(parsed.latestVersion);
  if (!latestVersion) {
    throw new AppError('latestVersion is required in app-update.json', 500, {
      code: 'APP_UPDATE_LATEST_VERSION_REQUIRED',
      details: {
        configPath,
      },
    });
  }

  const minimumSupportedVersion =
    sanitizeVersionToken(parsed.minimumSupportedVersion, latestVersion) || latestVersion;
  const releaseNotes = sanitizeText(parsed.releaseNotes, 2_000);
  const sha256Raw = sanitizeText(parsed.sha256, 128).toLowerCase();
  const sha256 = SHA256_PATTERN.test(sha256Raw) ? sha256Raw : '';
  const apkFileName = sanitizeApkFileName(parsed.apkFileName) || `green_toilet_v${latestVersion}.apk`;
  const explicitApkUrl = String(parsed.apkUrl || '').trim();

  const stat = fs.statSync(configPath);

  return {
    latestVersion,
    minimumSupportedVersion,
    releaseNotes,
    sha256,
    apkFileName,
    explicitApkUrl,
    updatedAt: stat.mtime.toISOString(),
    configPath,
  };
};

const resolveCandidateApkNames = ({ requestedVersion, config }) => {
  const candidates = [];

  if (requestedVersion === config.latestVersion) {
    candidates.push(config.apkFileName);
  }

  candidates.push(`green_toilet_v${requestedVersion}.apk`);
  candidates.push(`green_toilet-${requestedVersion}.apk`);
  candidates.push(`app_v${requestedVersion}.apk`);
  candidates.push(`${requestedVersion}.apk`);

  return Array.from(new Set(candidates.map((name) => sanitizeApkFileName(name)).filter(Boolean)));
};

const resolveVersionedApkPath = ({ apkDir, fileName }) => {
  const absoluteDir = path.resolve(apkDir);
  const absoluteFile = path.resolve(absoluteDir, fileName);

  if (!absoluteFile.startsWith(`${absoluteDir}${path.sep}`)) {
    throw new AppError('Invalid APK file path resolution', 400, {
      code: 'APP_UPDATE_INVALID_APK_PATH',
    });
  }

  return absoluteFile;
};

const getAppUpdateMetadata = (req) => {
  const config = readConfigPayload();
  const apkUrl =
    config.explicitApkUrl ||
    `${resolvePublicApiBaseUrl(req)}/api/v1/app/apk/${encodeURIComponent(config.latestVersion)}`;

  return {
    latestVersion: config.latestVersion,
    minimumSupportedVersion: config.minimumSupportedVersion,
    apkUrl,
    apkFileName: config.apkFileName,
    releaseNotes: config.releaseNotes,
    sha256: config.sha256,
    updatedAt: config.updatedAt,
  };
};

const resolveApkDownload = (req) => {
  const requestedVersion = sanitizeVersionToken(req.params.version);
  if (!requestedVersion) {
    throw new AppError('Invalid app version', 400, {
      code: 'APP_UPDATE_INVALID_VERSION',
    });
  }

  const config = readConfigPayload();
  const apkDir = resolveApkDirectoryPath();
  const candidates = resolveCandidateApkNames({ requestedVersion, config });

  let selected = null;
  for (const candidate of candidates) {
    const candidatePath = resolveVersionedApkPath({
      apkDir,
      fileName: candidate,
    });
    if (fs.existsSync(candidatePath)) {
      selected = {
        fileName: candidate,
        filePath: candidatePath,
      };
      break;
    }
  }

  if (!selected) {
    throw new AppError('APK not found for requested version', 404, {
      code: 'APP_UPDATE_APK_NOT_FOUND',
      details: {
        requestedVersion,
        apkDirectory: apkDir,
        searched: candidates,
      },
    });
  }

  return selected;
};

module.exports = {
  getAppUpdateMetadata,
  resolveApkDownload,
};
