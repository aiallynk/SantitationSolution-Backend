#!/usr/bin/env node
'use strict';

/*
 * Canonical Green Toilet Android release tool.
 * It builds/prepares one APK, serves that same verified artifact to the
 * in-app updater, and optionally uploads it to Firebase App Distribution.
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const APP_ROOT = path.join(REPO_ROOT, 'SanitationSolution-App');
const PUBSPEC_PATH = path.join(APP_ROOT, 'pubspec.yaml');
const APK_SOURCE_PATH = path.join(APP_ROOT, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
const APK_DIR = path.join(BACKEND_ROOT, 'apk');
const METADATA_PATH = path.join(BACKEND_ROOT, 'app-update.json');
const REPORTS_DIR = path.join(BACKEND_ROOT, 'release-reports', 'app-update');
const FIREBASE_CONFIG_PATH = path.join(APP_ROOT, 'firebase.json');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

class ReleaseError extends Error {
  constructor(message, code = 'RELEASE_ERROR') { super(message); this.code = code; }
}

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('--')) || 'help';
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
};
const has = (name) => args.includes(`--${name}`);
const log = (...items) => console.log(...items);

const parsePubspecVersion = () => {
  const raw = fs.readFileSync(PUBSPEC_PATH, 'utf8');
  const match = raw.match(/^\s*version\s*:\s*([^\s]+)\s*$/m);
  if (!match) throw new ReleaseError('pubspec.yaml is missing a version value.', 'PUBSPEC_VERSION_MISSING');
  const [version, buildRaw] = match[1].trim().split('+');
  if (!VERSION_PATTERN.test(version) || !/^\d+$/.test(buildRaw || '')) {
    throw new ReleaseError('pubspec version must use x.y.z+N (for example 1.0.20+20).', 'PUBSPEC_VERSION_INVALID');
  }
  return { version, buildNumber: Number(buildRaw) };
};

const sha256 = async (filePath) => new Promise((resolve, reject) => {
  const digest = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('data', (chunk) => digest.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(digest.digest('hex')));
});

const atomicWrite = async (filePath, content) => {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fsp.writeFile(temporary, content, 'utf8');
  await fsp.rename(temporary, filePath);
};

const run = (binary, binaryArgs, { cwd = BACKEND_ROOT, env = process.env } = {}) => {
  const result = spawnSync(binary, binaryArgs, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw new ReleaseError(`Could not start ${binary}: ${result.error.message}`, 'PROCESS_START_FAILED');
  if (result.status !== 0) throw new ReleaseError(`${binary} failed: ${(result.stderr || result.stdout || '').trim().slice(-2000)}`, 'PROCESS_FAILED');
  return result.stdout || '';
};

const build = () => {
  log('Building signed release APK with Flutter...');
  run('flutter', ['build', 'apk', '--release'], { cwd: APP_ROOT });
  if (!fs.existsSync(APK_SOURCE_PATH)) throw new ReleaseError('Flutter did not produce app-release.apk.', 'APK_BUILD_MISSING');
};

const readMetadata = () => {
  try { return JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new ReleaseError(`Cannot read app-update.json: ${error.message}`, 'METADATA_INVALID'); }
};

const prepare = async () => {
  const { version, buildNumber } = parsePubspecVersion();
  const source = path.resolve(option('apk') || APK_SOURCE_PATH);
  if (!fs.existsSync(source)) throw new ReleaseError(`Release APK not found: ${source}. Run app-release:build first.`, 'APK_NOT_FOUND');
  const targetName = `green_toilet_v${version}.apk`;
  const target = path.join(APK_DIR, targetName);
  const sourceHash = await sha256(source);
  if (has('dry-run')) {
    log(JSON.stringify({ dryRun: true, version, buildNumber, source, target, sha256: sourceHash }, null, 2));
    return { version, buildNumber, source, target, sha256: sourceHash, metadata: readMetadata() };
  }
  await fsp.mkdir(APK_DIR, { recursive: true });
  if (fs.existsSync(target) && await sha256(target) !== sourceHash) {
    throw new ReleaseError(`Refusing to overwrite published APK with different bytes: ${target}`, 'APK_VERSION_COLLISION');
  }
  if (!fs.existsSync(target)) {
    const temporary = `${target}.${process.pid}.tmp`;
    await fsp.copyFile(source, temporary);
    if (await sha256(temporary) !== sourceHash) throw new ReleaseError('Copied APK checksum mismatch.', 'APK_COPY_MISMATCH');
    await fsp.rename(temporary, target);
  }
  const metadata = readMetadata();
  const updated = {
    ...metadata,
    latestVersion: version,
    latestBuildNumber: buildNumber,
    minimumSupportedVersion: option('minimum-version') || metadata.minimumSupportedVersion || version,
    minimumSupportedBuildNumber: Number(option('minimum-build-number') || metadata.minimumSupportedBuildNumber || 0),
    apkUrl: metadata.apkUrl || '',
    apkFileName: targetName,
    releaseNotes: option('release-notes') || metadata.releaseNotes || '',
    sha256: sourceHash,
    checksum: sourceHash,
  };
  if (!VERSION_PATTERN.test(String(updated.minimumSupportedVersion))) throw new ReleaseError('minimumSupportedVersion must use x.y.z.', 'MINIMUM_VERSION_INVALID');
  await atomicWrite(METADATA_PATH, `${JSON.stringify(updated, null, 2)}\n`);
  log(`Prepared ${targetName} (${version}+${buildNumber})`);
  return { version, buildNumber, source, target, sha256: sourceHash, metadata: updated };
};

const firebaseAppId = () => {
  const explicit = String(process.env.FIREBASE_ANDROID_APP_ID || '').trim();
  if (explicit) return explicit;
  try { return String(JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf8')).flutter.platforms.android.default.appId || '').trim(); }
  catch (_) { return ''; }
};

const distributeFirebase = async (release) => {
  const appId = firebaseAppId();
  const groups = option('firebase-groups') || String(process.env.FIREBASE_DISTRIBUTION_GROUPS || '').trim();
  const testers = option('firebase-testers') || String(process.env.FIREBASE_DISTRIBUTION_TESTERS || '').trim();
  const credentials = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const token = String(process.env.FIREBASE_TOKEN || '').trim();
  if (!/^1:\d+:android:[a-f0-9]+$/i.test(appId)) throw new ReleaseError('FIREBASE_ANDROID_APP_ID is missing or invalid.', 'FIREBASE_APP_ID_INVALID');
  if (!groups && !testers) throw new ReleaseError('Set FIREBASE_DISTRIBUTION_GROUPS or FIREBASE_DISTRIBUTION_TESTERS.', 'FIREBASE_RECIPIENTS_MISSING');
  if (!credentials && !token) throw new ReleaseError('Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_TOKEN before uploading.', 'FIREBASE_AUTH_MISSING');
  if (credentials && !fs.existsSync(credentials)) throw new ReleaseError('GOOGLE_APPLICATION_CREDENTIALS points to a missing file.', 'FIREBASE_CREDENTIALS_MISSING');
  const notes = `${release.metadata.releaseNotes || 'Green Toilet release.'}\n\nVersion: ${release.version}+${release.buildNumber}\nSHA-256: ${release.sha256}`;
  if (has('dry-run')) { log(JSON.stringify({ dryRun: true, apk: release.target, appId, groups: groups || null, testers: testers || null, notes }, null, 2)); return; }
  const notesPath = path.join(REPORTS_DIR, `.firebase-notes-${process.pid}.txt`);
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  await fsp.writeFile(notesPath, notes, 'utf8');
  try {
    const cliArgs = ['--yes', 'firebase-tools', 'appdistribution:distribute', release.target, '--app', appId, '--release-notes-file', notesPath];
    if (groups) cliArgs.push('--groups', groups);
    if (testers) cliArgs.push('--testers', testers);
    run(process.platform === 'win32' ? 'npx.cmd' : 'npx', cliArgs);
  } finally { await fsp.rm(notesPath, { force: true }); }
  log('Firebase App Distribution upload completed.');
};

const verifyLocal = async () => {
  const release = await prepare();
  const service = require('../src/modules/appUpdate/appUpdate.service');
  const req = { protocol: 'https', get: () => 'updates.example.invalid', params: { version: release.version } };
  const metadata = service.getAppUpdateMetadata(req);
  const resolved = service.resolveApkDownload(req);
  if (metadata.latestVersion !== release.version || Number(metadata.latestBuildNumber) !== release.buildNumber || await sha256(resolved.filePath) !== release.sha256) {
    throw new ReleaseError('Local in-app update verification failed.', 'LOCAL_VERIFY_FAILED');
  }
  log('Local update metadata and APK checksum verified.');
};

const writeReport = async (release, firebaseUploaded) => {
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  await atomicWrite(path.join(REPORTS_DIR, `${release.version}+${release.buildNumber}.json`), `${JSON.stringify({ ...release, firebaseDistribution: firebaseUploaded ? 'uploaded' : 'not_requested', releasedAt: new Date().toISOString() }, null, 2)}\n`);
};

const main = async () => {
  if (command === 'build') return build();
  if (command === 'prepare') return prepare();
  if (command === 'verify-local') return verifyLocal();
  if (command === 'firebase') { const release = await prepare(); await distributeFirebase(release); return writeReport(release, true); }
  if (command === 'release' || command === 'complete') {
    if (!has('skip-build')) build();
    const release = await prepare();
    const wantsFirebase = command === 'complete' || has('firebase');
    if (wantsFirebase && !has('skip-firebase')) await distributeFirebase(release);
    await writeReport(release, wantsFirebase && !has('skip-firebase'));
    log('Release prepared. Deploy SantitationSolution-Backend with app-update.json and apk/ before relying on in-app updates.');
    return;
  }
  log('Usage: node scripts/release-app-update.js <build|prepare|verify-local|firebase|release|complete> [--skip-build] [--firebase] [--firebase-groups group] [--firebase-testers email] [--release-notes text]');
};

main().catch((error) => { console.error(`[${error.code || 'RELEASE_ERROR'}] ${error.message}`); process.exitCode = 1; });
