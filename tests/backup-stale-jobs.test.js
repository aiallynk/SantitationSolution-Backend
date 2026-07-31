'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeBackupHeartbeatAt,
  isStaleActiveBackupJob,
} = require('../src/modules/backups/backup.service');

test('backup stale detection uses latest progress heartbeat', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const job = {
    status: 'running',
    created_at: new Date('2026-07-20T08:00:00.000Z'),
    started_at: new Date('2026-07-20T08:00:00.000Z'),
    metadata: {
      progress: { updatedAt: '2026-07-20T11:30:00.000Z' },
    },
  };

  assert.equal(activeBackupHeartbeatAt(job).toISOString(), '2026-07-20T11:30:00.000Z');
  assert.equal(isStaleActiveBackupJob(job, now, 60 * 60 * 1000), false);
});

test('old queued or running backup jobs are stale but completed jobs are not', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const oldRunning = {
    status: 'running',
    created_at: new Date('2026-07-20T08:00:00.000Z'),
    started_at: new Date('2026-07-20T08:00:00.000Z'),
    metadata: { progress: { updatedAt: '2026-07-20T08:15:00.000Z' } },
  };
  const oldQueued = {
    status: 'queued',
    created_at: new Date('2026-07-20T08:00:00.000Z'),
    metadata: {},
  };
  const oldSuccess = {
    status: 'success',
    created_at: new Date('2026-07-20T08:00:00.000Z'),
    metadata: { progress: { updatedAt: '2026-07-20T08:15:00.000Z' } },
  };

  assert.equal(isStaleActiveBackupJob(oldRunning, now, 2 * 60 * 60 * 1000), true);
  assert.equal(isStaleActiveBackupJob(oldQueued, now, 2 * 60 * 60 * 1000), true);
  assert.equal(isStaleActiveBackupJob(oldSuccess, now, 2 * 60 * 60 * 1000), false);
});
