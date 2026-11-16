import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { upgrader } from './upgrade.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-16-2345-the-hub-reports-its-pull-and-the-page-reads-it.md
const scratch = tempDir('upgrade-pull-');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function install(version) {
  const root = path.join(scratch, `kickflip-${n++}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@lovek4d/kickflip', version }));
  return root;
}
const fetch = async () => ({ ok: true, status: 200, json: async () => ({ version: '0.7.2' }) });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('pull reports idle, then the version being pulled, then a failure with its reason until the next pull starts', async () => {
  let finish;
  const up = upgrader({ root: install('0.7.1'), fetch, run: () => new Promise((resolve) => { finish = resolve; }) });
  assert.deepEqual(up.pull(), { state: 'idle' });
  await up.check();
  assert.deepEqual(up.pull(), { state: 'pulling', latest: '0.7.2' });
  finish({ ok: false, error: 'npm exited 1' });
  await settle();
  assert.deepEqual(up.pull(), { state: 'failed', latest: '0.7.2', error: 'npm exited 1' });
  await up.check();
  assert.deepEqual(up.pull(), { state: 'pulling', latest: '0.7.2' });
});

test('a pull that exits OK but leaves the version put is a failure that says so, and one that installs the version is idle again', async () => {
  const left = upgrader({ root: install('0.7.1'), fetch, run: async () => ({ ok: true }) });
  await left.check();
  await settle();
  assert.deepEqual(left.pull(), { state: 'failed', latest: '0.7.2', error: 'it left v0.7.1 installed' });

  const root = install('0.7.1');
  let restarts = 0;
  const done = upgrader({ root, fetch, pulled: () => restarts++, run: async () => { fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.2' })); return { ok: true }; } });
  await done.check();
  await settle();
  assert.deepEqual(done.pull(), { state: 'idle' });
  assert.equal(restarts, 1);
});

test('a pull that throws is a failure with its message', async () => {
  const up = upgrader({ root: install('0.7.1'), fetch, run: async () => { throw new Error('spawn failed'); } });
  await up.check();
  await settle();
  assert.deepEqual(up.pull(), { state: 'failed', latest: '0.7.2', error: 'spawn failed' });
});
