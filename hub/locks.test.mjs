import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withFileLock } from './locks.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'locks-')), 'data.json');

// docs/adr/2026-11-09-2200-a-file-lock-records-its-holder-and-a-gone-holder-loses-it.md
test('a lock whose holder process is gone is taken at once, not after staleAfter', async () => {
  const file = tmp();
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(`${file}.lock`);
  fs.writeFileSync(path.join(`${file}.lock`, 'pid'), String(gone));
  const started = performance.now();
  assert.equal(await withFileLock(file, () => 'ran', { timeout: 2000 }), 'ran');
  assert.ok(performance.now() - started < 1000);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

test('a lock held by a live process still makes a waiter wait, then fail', async () => {
  const file = tmp();
  await assert.rejects(
    withFileLock(file, () => withFileLock(file, () => {}, { timeout: 300 })),
    { code: 'ELOCKED' },
  );
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a lock with no pid recorded still goes stale by age', async () => {
  const file = tmp();
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.equal(await withFileLock(file, () => 'ran', { timeout: 2000 }), 'ran');
});
