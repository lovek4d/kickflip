import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { restarter } from './self-restart.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const scratch = tempDir('self-restart-');
let n = 0;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
function clone() {
  const root = path.join(scratch, `c${n++}`);
  fs.mkdirSync(path.join(root, 'hub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub', 'hub.mjs'), 'a');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  return root;
}
const commit = (root, text) => { fs.writeFileSync(path.join(root, 'hub', 'hub.mjs'), text); git(root, 'commit', '-qam', text); };
function setup(root, failure = null) {
  const calls = [];
  const logs = [];
  const r = restarter({ root, files: ['hub/hub.mjs'], restart: () => { calls.push(1); return failure; }, log: (...a) => logs.push(a.join(' ')) });
  return { r, calls, logs };
}

test('a clone whose HEAD has not moved never restarts', async () => {
  const { r, calls } = setup(clone());
  await r.check();
  assert.equal(calls.length, 0);
});

test('a moved HEAD with the hub files matching it restarts once per new HEAD', async () => {
  const root = clone();
  const { r, calls } = setup(root);
  commit(root, 'b');
  await r.check();
  await r.check();
  assert.equal(calls.length, 1);
  commit(root, 'c');
  await r.check();
  assert.equal(calls.length, 2);
});

test('a git operation in progress holds the restart until it ends', async () => {
  const root = clone();
  const { r, calls } = setup(root);
  commit(root, 'b');
  fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');
  await r.check();
  assert.equal(calls.length, 0);
  fs.rmSync(path.join(root, '.git', 'index.lock'));
  fs.mkdirSync(path.join(root, '.git', 'rebase-merge'));
  await r.check();
  assert.equal(calls.length, 0);
  fs.rmdirSync(path.join(root, '.git', 'rebase-merge'));
  await r.check();
  assert.equal(calls.length, 1);
});

test('hand edits to the hub files never restart it', async () => {
  const root = clone();
  const { r, calls } = setup(root);
  commit(root, 'b');
  fs.writeFileSync(path.join(root, 'hub', 'hub.mjs'), 'edited');
  await r.check();
  assert.equal(calls.length, 0);
});

test('a failed restart logs why once and is not tried again for that code', async () => {
  const root = clone();
  const { r, calls, logs } = setup(root, 'no service');
  commit(root, 'b');
  await r.check();
  await r.check();
  assert.equal(calls.length, 1);
  assert.equal(logs.filter((l) => /no service/.test(l)).length, 1);
});

test('a finished npm update restarts once idle, as at once with nothing running, and a clone check does nothing for an npm install', async () => {
  const root = path.join(scratch, `npm${n++}`);
  fs.mkdirSync(root);
  const { r, calls } = setup(root);
  await r.check();
  assert.equal(calls.length, 0);
  await r.restartNow();
  assert.equal(calls.length, 1);
});

test('a git that cannot read HEAD logs once and never stops the hub or restarts it', async () => {
  const root = clone();
  const logs = [];
  const calls = [];
  const r = restarter({ root, files: ['hub/hub.mjs'], restart: () => { calls.push(1); return null; }, log: (...a) => logs.push(a.join(' ')), git: () => { throw new Error('git is broken'); } });
  await r.check();
  await r.check();
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /git is broken/);
});

// docs/adr/2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md
test("new hub code, pulled or installed, waits while idle() names what holds it, saying so once per reason, and restarts once nothing does", async () => {
  const root = clone();
  const calls = [];
  const logs = [];
  let held = 'a builder is open on /shop';
  const r = restarter({ root, files: ['hub/hub.mjs'], restart: () => { calls.push(1); return null; }, idle: async () => held, log: (...a) => logs.push(a.join(' ')) });
  commit(root, 'b');
  await r.check();
  await r.check();
  assert.equal(calls.length, 0);
  held = 'auto restart is off';
  await r.check();
  assert.deepEqual(logs, ['new hub code waits to restart, since a builder is open on /shop', 'new hub code waits to restart, since auto restart is off']);
  held = null;
  await r.check();
  assert.equal(calls.length, 1);

  const npm = path.join(scratch, `npm${n++}`);
  fs.mkdirSync(npm);
  held = 'a land is queued or landing';
  const installed = restarter({ root: npm, files: ['hub/hub.mjs'], restart: () => { calls.push(2); return null; }, idle: async () => held });
  await installed.restartNow();
  assert.deepEqual(calls, [1]);
  held = null;
  await installed.check();
  assert.deepEqual(calls, [1, 2], 'the next check restarts the update the land held');
});
