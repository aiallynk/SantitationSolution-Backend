const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildPgEnv,
  normalizeReason,
  parseDatabaseUrl,
  resolvePostgresTool,
  schemaContainsTables,
  verifyBackupDirectory,
  writeChecksums,
} = require('../scripts/backup-database');

const makeBackupFixture = ({ schema }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
  fs.writeFileSync(path.join(dir, 'database.dump'), 'custom dump fixture');
  fs.writeFileSync(path.join(dir, 'database.schema.sql'), schema);
  fs.writeFileSync(path.join(dir, 'database.data.sql'), 'data fixture');
  fs.writeFileSync(path.join(dir, 'backup-log.txt'), 'log fixture');
  fs.writeFileSync(
    path.join(dir, 'backup-manifest.json'),
    JSON.stringify({
      backupId: 'backup-1',
      verification: { status: 'passed' },
    })
  );
  writeChecksums(dir, [
    'database.dump',
    'database.schema.sql',
    'database.data.sql',
    'backup-log.txt',
    'backup-manifest.json',
  ]);
  return dir;
};

const validSchema = `
CREATE TABLE public.inspections (id uuid);
CREATE TABLE public.inspection_media (id uuid);
CREATE TABLE public.sensor_devices (id uuid);
CREATE TABLE public.sensor_readings (id uuid);
`;

test('database URL parsing derives safe connection info without exposing password', () => {
  const parsed = parseDatabaseUrl('postgres://db_user:secret-pass@example.com:5433/sanitation?sslmode=require');
  assert.equal(parsed.host, 'example.com');
  assert.equal(parsed.port, '5433');
  assert.equal(parsed.databaseName, 'sanitation');
  assert.equal(parsed.username, 'db_user');
  assert.equal(parsed.password, 'secret-pass');

  const pg = buildPgEnv({
    databaseUrl: 'postgres://db_user:secret-pass@example.com:5433/sanitation?sslmode=require',
  });
  assert.deepEqual(pg.info, {
    host: 'example.com',
    port: '5433',
    databaseName: 'sanitation',
    username: 'db_user',
    sslMode: 'require',
  });
  assert.equal(pg.env.PGPASSWORD, 'secret-pass');
});

test('backup reason normalizes the historical backfill alias to the canonical manifest reason', () => {
  assert.equal(normalizeReason('sensor-historical-backfill'), 'pre_sensor_historical_backfill_backup');
  assert.equal(normalizeReason(''), 'pre_sensor_historical_backfill_backup');
  assert.equal(normalizeReason('manual-audit'), 'manual-audit');
});

test('PostgreSQL tool resolver finds executables from PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tool-path-'));
  const executable = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  const toolPath = path.join(dir, executable);
  fs.writeFileSync(toolPath, '');
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`;
    assert.equal(resolvePostgresTool('pg_dump'), toolPath);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('schema verification requires the core backfill tables', () => {
  assert.deepEqual(schemaContainsTables(validSchema), []);
  assert.deepEqual(schemaContainsTables('CREATE TABLE public.inspections (id uuid);'), [
    'inspection_media',
    'sensor_devices',
    'sensor_readings',
  ]);
});

test('backup verifier checks files, checksums, pg_restore list, and schema tables', async () => {
  const dir = makeBackupFixture({ schema: validSchema });
  const result = await verifyBackupDirectory(dir, {
    commandRunner: async () => ({ ok: true, stdout: 'TABLE DATA', stderr: '', exitCode: 0 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, 'passed');
});

test('backup verifier rejects missing schema tables', async () => {
  const dir = makeBackupFixture({ schema: 'CREATE TABLE public.inspections (id uuid);' });
  await assert.rejects(
    verifyBackupDirectory(dir, {
      commandRunner: async () => ({ ok: true, stdout: 'TABLE DATA', stderr: '', exitCode: 0 }),
    }),
    /missing expected table definitions/
  );
});

test('backup verifier rejects checksum mismatches', async () => {
  const dir = makeBackupFixture({ schema: validSchema });
  fs.appendFileSync(path.join(dir, 'database.data.sql'), 'tampered');
  await assert.rejects(
    verifyBackupDirectory(dir, {
      commandRunner: async () => ({ ok: true, stdout: 'TABLE DATA', stderr: '', exitCode: 0 }),
    }),
    /Checksum mismatch/
  );
});
