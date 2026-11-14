import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lockWaits, withFileLock } from './locks.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const tmp = () => path.join(tempDir('locks-'), 'data.json');
const noWait = () => assert.fail('waited for the lock');

// docs/adr/2026-11-09-2200-a-file-lock-records-its-holder-and-a-gone-holder-loses-it.md
test('a lock whose holder process is gone is taken at once, not after staleAfter', async () => {
  const file = tmp();
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(`${file}.lock`);
  fs.writeFileSync(path.join(`${file}.lock`, 'pid'), String(gone));
  assert.equal(await withFileLock(file, () => 'ran', { wait: noWait }), 'ran');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

test('a lock held by a live process still makes a waiter wait, saying so each time, then fail at its deadline', async () => {
  const file = tmp();
  let clock = 0;
  const waits = [];
  const said = [];
  const heard = (waited) => said.push(waited);
  lockWaits.on('wait', heard);
  try {
    await assert.rejects(
      withFileLock(file, () => withFileLock(file, () => {}, { timeout: 300, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } })),
      { code: 'ELOCKED' },
    );
  } finally { lockWaits.off('wait', heard); }
  assert.deepEqual(waits, [100, 100, 100, 100], 'it waits until the deadline has passed, then fails');
  assert.deepEqual(said, [file, file, file, file]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a lock with no pid recorded still goes stale by age', async () => {
  const file = tmp();
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.equal(await withFileLock(file, () => 'ran', { wait: noWait }), 'ran');
});
