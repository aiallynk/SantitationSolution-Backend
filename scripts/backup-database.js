#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_VERSION = 'sensor-backfill-backup-v1';
const REQUIRED_TABLES = ['inspections', 'inspection_media', 'sensor_devices', 'sensor_readings'];
const PRE_SENSOR_BACKFILL_REASON = 'pre_sensor_historical_backfill_backup';

const nowIso = () => new Date().toISOString();

const pad2 = (value) => String(value).padStart(2, '0');

const timestampId = (date = new Date()) => (
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
  `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-sensor-backfill`
);

const executableName = (toolName) => {
  if (process.platform !== 'win32') return toolName;
  return toolName.toLowerCase().endsWith('.exe') ? toolName : `${toolName}.exe`;
};

const existingFile = (filePath) => {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
};

const sortPostgresDirsNewestFirst = (dirs) =>
  dirs.sort((left, right) => {
    const leftVersion = Number((left.match(/PostgreSQL[\\/](\d+)/i) || [])[1] || 0);
    const rightVersion = Number((right.match(/PostgreSQL[\\/](\d+)/i) || [])[1] || 0);
    return rightVersion - leftVersion || right.localeCompare(left);
  });

const commonWindowsPostgresToolCandidates = (toolName) => {
  if (process.platform !== 'win32') return [];
  const exe = executableName(toolName);
  const roots = ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL'];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = path.join(root, entry.name);
      candidates.push(path.join(base, 'bin', exe));
      candidates.push(path.join(base, 'pgAdmin 4', 'runtime', exe));
    }
  }
  return sortPostgresDirsNewestFirst(candidates);
};

const resolvePostgresTool = (toolName, options = {}) => {
  if (options.commandRunner) return toolName;
  const exe = executableName(toolName);
  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, exe);
    if (existingFile(candidate)) return candidate;
  }
  for (const candidate of commonWindowsPostgresToolCandidates(toolName)) {
    if (existingFile(candidate)) return candidate;
  }
  return toolName;
};

const parseArgs = (argv = process.argv.slice(2)) => {
  const args = {
    reason: PRE_SENSOR_BACKFILL_REASON,
    outputDir: 'backups/db',
    verifyOnly: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reason') {
      args.reason = argv[++i];
    } else if (arg === '--output-dir') {
      args.outputDir = argv[++i];
    } else if (arg === '--verify-only') {
      args.verifyOnly = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
};

const usage = () => `
Usage:
  node scripts/backup-database.js --reason sensor-historical-backfill
  node scripts/backup-database.js --output-dir backups/db
  node scripts/backup-database.js --verify-only backups/db/<backup-id>/database.dump
`;

const ensureValue = (value, message) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(message);
  }
  return value;
};

const normalizeReason = (reason) => {
  const text = String(reason || '').trim();
  if (!text || text === 'sensor-historical-backfill') return PRE_SENSOR_BACKFILL_REASON;
  return text;
};

const loadRuntimeConfig = () => {
  const { runtimeConfig } = require('../src/config/runtime');
  return runtimeConfig;
};

const parseDatabaseUrl = (databaseUrl) => {
  const raw = ensureValue(databaseUrl, 'DATABASE_URL is required for database backup');
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const databaseName = decodeURIComponent(String(url.pathname || '').replace(/^\//, ''));
  if (!databaseName) throw new Error('DATABASE_URL is missing a database name');
  return {
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    databaseName,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    sslMode: url.searchParams.get('sslmode') || null,
  };
};

const buildPgEnv = ({ databaseUrl, runtimeConfig = null }) => {
  const parsed = parseDatabaseUrl(databaseUrl);
  const sslMode = parsed.sslMode || (runtimeConfig?.database?.ssl ? 'require' : null);
  return {
    info: {
      host: parsed.host,
      port: parsed.port,
      databaseName: parsed.databaseName,
      username: parsed.username || null,
      sslMode,
    },
    env: {
      ...process.env,
      PGHOST: parsed.host,
      PGPORT: parsed.port,
      PGDATABASE: parsed.databaseName,
      PGUSER: parsed.username,
      PGPASSWORD: parsed.password,
      ...(sslMode ? { PGSSLMODE: sslMode } : {}),
    },
  };
};

const runCommand = (command, args = [], options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ ok: false, command, args, exitCode: null, stdout, stderr, error: error.message });
    });
    child.on('close', (exitCode) => {
      resolve({ ok: exitCode === 0, command, args, exitCode, stdout, stderr, error: null });
    });
  });

const runRequiredCommand = async (command, args, options, label, logLines) => {
  logLines.push(`[${nowIso()}] ${label}: ${command} ${args.join(' ')}`);
  const result = await (options.commandRunner || runCommand)(command, args, options);
  if (result.stdout) logLines.push(`[${nowIso()}] ${label} stdout:\n${result.stdout.trim()}`);
  if (result.stderr) logLines.push(`[${nowIso()}] ${label} stderr:\n${result.stderr.trim()}`);
  if (!result.ok) {
    throw new Error(`${label} failed${result.error ? `: ${result.error}` : ''}`);
  }
  return {
    label,
    command,
    args,
    exitCode: result.exitCode,
    ok: true,
  };
};

const hashFile = (filePath) => {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
};

const fileSize = (filePath) => fs.statSync(filePath).size;

const buildFileRecord = (backupDir, fileName) => {
  const absolutePath = path.join(backupDir, fileName);
  return {
    path: absolutePath,
    relativePath: fileName,
    sizeBytes: fileSize(absolutePath),
    checksumSha256: hashFile(absolutePath),
  };
};

const writeChecksums = (backupDir, fileNames) => {
  const lines = fileNames.map((fileName) => `${hashFile(path.join(backupDir, fileName))}  ${fileName}`);
  fs.writeFileSync(path.join(backupDir, 'backup-checksums.sha256'), `${lines.join('\n')}\n`);
};

const readChecksumFile = (checksumPath) => {
  const text = fs.readFileSync(checksumPath, 'utf8');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    entries.push({ checksum: match[1].toLowerCase(), relativePath: match[2].trim() });
  }
  if (entries.length === 0) throw new Error('Backup checksum file is empty');
  return entries;
};

const verifyChecksumFile = (backupDir) => {
  const checksumPath = path.join(backupDir, 'backup-checksums.sha256');
  if (!fs.existsSync(checksumPath)) throw new Error('backup-checksums.sha256 is missing');
  const entries = readChecksumFile(checksumPath);
  const files = {};
  for (const entry of entries) {
    const target = path.join(backupDir, entry.relativePath);
    if (!fs.existsSync(target)) throw new Error(`Checksum target is missing: ${entry.relativePath}`);
    const actual = hashFile(target);
    if (actual !== entry.checksum) {
      throw new Error(`Checksum mismatch for ${entry.relativePath}`);
    }
    files[entry.relativePath] = actual;
  }
  return files;
};

const resolveBackupDirForVerify = (inputPath) => {
  const target = path.resolve(inputPath || '');
  if (!fs.existsSync(target)) throw new Error(`Backup path does not exist: ${inputPath}`);
  const stat = fs.statSync(target);
  return stat.isDirectory() ? target : path.dirname(target);
};

const assertNonEmptyFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing`);
  if (fileSize(filePath) <= 0) throw new Error(`${label} is empty`);
};

const schemaContainsTables = (schemaText) => {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const pattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?${table}"?\\s*\\(`, 'i');
    if (!pattern.test(schemaText)) missing.push(table);
  }
  return missing;
};

const verifyBackupDirectory = async (backupPath, options = {}) => {
  const pgRestoreCommand = options.pgRestoreCommand || resolvePostgresTool('pg_restore', {
    commandRunner: options.commandRunner,
  });
  const backupDir = resolveBackupDirForVerify(backupPath);
  const manifestPath = path.join(backupDir, 'backup-manifest.json');
  const dumpPath = path.join(backupDir, 'database.dump');
  const schemaPath = path.join(backupDir, 'database.schema.sql');
  const dataPath = path.join(backupDir, 'database.data.sql');
  const logPath = path.join(backupDir, 'backup-log.txt');

  assertNonEmptyFile(manifestPath, 'backup-manifest.json');
  assertNonEmptyFile(dumpPath, 'database.dump');
  assertNonEmptyFile(schemaPath, 'database.schema.sql');
  assertNonEmptyFile(dataPath, 'database.data.sql');
  assertNonEmptyFile(logPath, 'backup-log.txt');

  const checksumResults = verifyChecksumFile(backupDir);
  const restoreResult = await (options.commandRunner || runCommand)(pgRestoreCommand, ['--list', dumpPath], {
    env: process.env,
  });
  if (!restoreResult.ok) {
    throw new Error('pg_restore --list database.dump verification failed');
  }

  const schemaText = fs.readFileSync(schemaPath, 'utf8');
  const missingTables = schemaContainsTables(schemaText);
  if (missingTables.length > 0) {
    throw new Error(`Schema backup is missing expected table definitions: ${missingTables.join(', ')}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!options.allowPendingManifest && manifest.verification?.status && manifest.verification.status !== 'passed') {
    throw new Error('Backup manifest verification status is not passed');
  }

  return {
    ok: true,
    backupDir,
    manifest,
    checksumResults,
    verification: {
      status: 'passed',
      verifiedAt: nowIso(),
      pgRestoreList: 'passed',
      schemaTables: REQUIRED_TABLES,
    },
  };
};

const getGitCommit = async (commandRunner = runCommand) => {
  const result = await commandRunner('git', ['rev-parse', 'HEAD'], { env: process.env });
  return result.ok ? String(result.stdout || '').trim() || null : null;
};

const createDatabaseBackup = async (options = {}) => {
  const runtimeConfig = options.runtimeConfig || loadRuntimeConfig();
  const databaseUrl = ensureValue(runtimeConfig.database?.url, 'DATABASE_URL is required for database backup');
  const outputRoot = path.resolve(options.outputDir || 'backups/db');
  const backupId = options.backupId || timestampId();
  const backupDir = path.join(outputRoot, backupId);
  const logLines = [`[${nowIso()}] Starting database backup ${backupId}`];
  const commandRunner = options.commandRunner || runCommand;
  const pgDumpCommand = options.pgDumpCommand || resolvePostgresTool('pg_dump', {
    commandRunner: options.commandRunner,
  });
  const pgRestoreCommand = options.pgRestoreCommand || resolvePostgresTool('pg_restore', {
    commandRunner: options.commandRunner,
  });

  fs.mkdirSync(backupDir, { recursive: true });
  const { info, env } = buildPgEnv({ databaseUrl, runtimeConfig });

  const commandStatus = {};
  commandStatus.pgDumpVersion = await runRequiredCommand(pgDumpCommand, ['--version'], { commandRunner }, 'pg_dump version check', logLines);
  commandStatus.pgRestoreVersion = await runRequiredCommand(pgRestoreCommand, ['--version'], { commandRunner }, 'pg_restore version check', logLines);

  commandStatus.customDump = await runRequiredCommand(
    pgDumpCommand,
    ['--format=custom', '--no-owner', '--no-acl', '--file', path.join(backupDir, 'database.dump')],
    { env, commandRunner },
    'custom-format database dump',
    logLines
  );
  commandStatus.schemaDump = await runRequiredCommand(
    pgDumpCommand,
    ['--schema-only', '--no-owner', '--no-acl', '--file', path.join(backupDir, 'database.schema.sql')],
    { env, commandRunner },
    'schema-only database dump',
    logLines
  );
  commandStatus.dataDump = await runRequiredCommand(
    pgDumpCommand,
    ['--data-only', '--no-owner', '--no-acl', '--file', path.join(backupDir, 'database.data.sql')],
    { env, commandRunner },
    'data-only database dump',
    logLines
  );

  fs.writeFileSync(path.join(backupDir, 'backup-log.txt'), `${logLines.join('\n')}\n`);

  const gitCommit = await getGitCommit(commandRunner);
  const manifest = {
    backupId,
    reason: normalizeReason(options.reason),
    createdAt: nowIso(),
    scriptVersion: SCRIPT_VERSION,
    environmentName: runtimeConfig.env || process.env.NODE_ENV || null,
    gitCommit,
    database: info,
    files: {
      databaseDump: buildFileRecord(backupDir, 'database.dump'),
      schemaSql: buildFileRecord(backupDir, 'database.schema.sql'),
      dataSql: buildFileRecord(backupDir, 'database.data.sql'),
      log: buildFileRecord(backupDir, 'backup-log.txt'),
    },
    commandStatus,
    verification: {
      status: 'pending',
      verifiedAt: null,
    },
  };
  fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
  writeChecksums(backupDir, [
    'database.dump',
    'database.schema.sql',
    'database.data.sql',
    'backup-log.txt',
    'backup-manifest.json',
  ]);

  const verification = await verifyBackupDirectory(backupDir, { commandRunner, pgRestoreCommand, allowPendingManifest: true });
  manifest.verification = verification.verification;
  manifest.controlFiles = {
    manifest: {
      path: path.join(backupDir, 'backup-manifest.json'),
      relativePath: 'backup-manifest.json',
      note: 'The manifest checksum is recorded in backup-checksums.sha256.',
    },
    checksums: {
      path: path.join(backupDir, 'backup-checksums.sha256'),
      relativePath: 'backup-checksums.sha256',
      note: 'Self-checksum is intentionally omitted.',
    },
  };
  fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
  writeChecksums(backupDir, [
    'database.dump',
    'database.schema.sql',
    'database.data.sql',
    'backup-log.txt',
    'backup-manifest.json',
  ]);
  await verifyBackupDirectory(backupDir, { commandRunner, pgRestoreCommand });

  return {
    backupId,
    backupDir,
    manifest,
  };
};

const printSummary = (result) => {
  const files = result.manifest?.files || {};
  const sizes = Object.fromEntries(
    Object.entries(files)
      .filter(([, value]) => value?.sizeBytes !== undefined)
      .map(([key, value]) => [key, value.sizeBytes])
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        backupId: result.backupId || result.manifest?.backupId,
        backupDir: result.backupDir,
        fileSizes: sizes,
        verificationStatus: result.manifest?.verification?.status || result.verification?.status || 'passed',
        nextSteps: [
          'Review backup-manifest.json and backup-log.txt.',
          'Run the sensor snapshot backfill dry-run.',
          'Pass --backup-dir with this backup directory when applying.',
        ],
      },
      null,
      2
    )
  );
};

const main = async () => {
  const args = parseArgs();
  if (args.help) {
    console.log(usage().trim());
    return;
  }
  if (args.verifyOnly) {
    const verified = await verifyBackupDirectory(args.verifyOnly);
    printSummary({
      backupId: verified.manifest.backupId,
      backupDir: verified.backupDir,
      manifest: verified.manifest,
      verification: verified.verification,
    });
    return;
  }
  const result = await createDatabaseBackup({
    reason: normalizeReason(args.reason),
    outputDir: args.outputDir,
  });
  printSummary(result);
};

if (require.main === module) {
  main().catch((error) => {
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
  });
}

module.exports = {
  REQUIRED_TABLES,
  SCRIPT_VERSION,
  buildPgEnv,
  createDatabaseBackup,
  parseArgs,
  parseDatabaseUrl,
  normalizeReason,
  resolvePostgresTool,
  schemaContainsTables,
  timestampId,
  verifyBackupDirectory,
  verifyChecksumFile,
  writeChecksums,
};
