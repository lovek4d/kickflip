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

test('a clone whose HEAD has not moved never restarts', () => {
  const { r, calls } = setup(clone());
  r.check();
  assert.equal(calls.length, 0);
});

test('a moved HEAD with the hub files matching it restarts once per new HEAD', () => {
  const root = clone();
  const { r, calls } = setup(root);
  commit(root, 'b');
  r.check();
  r.check();
  assert.equal(calls.length, 1);
  commit(root, 'c');
  r.check();
  assert.equal(calls.length, 2);
});

test('a git operation in progress holds the restart until it ends', () => {
  const root = clone();
  const { r, calls } = setup(root);
  commit(root, 'b');
  fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');
  r.check();
  assert.equal(calls.length, 0);
  fs.rmSync(path.join(root, '.git', 'index.lock'));
  fs.mkdirSync(path.join(root, '.git', 'rebase-merge'));
  r.check();
  assert.equal(calls.length, 0);
  fs.rmdirSync(path.join(root, '.git', 'rebase-merge'));
  r.check();
  assert.equal(calls.length, 1);
});

test('hand edits to the hub files never restart it', () => {
  const root = clone();
  const { r, calls } = setup(root);
  commit(root, 'b');
  fs.writeFileSync(path.join(root, 'hub', 'hub.mjs'), 'edited');
  r.check();
  assert.equal(calls.length, 0);
});

test('a failed restart logs why once and is not tried again for that code', () => {
  const root = clone();
  const { r, calls, logs } = setup(root, 'no service');
  commit(root, 'b');
  r.check();
  r.check();
  assert.equal(calls.length, 1);
  assert.equal(logs.filter((l) => /no service/.test(l)).length, 1);
});

test('a finished npm update restarts at once, and a clone check does nothing for an npm install', () => {
  const root = path.join(scratch, `npm${n++}`);
  fs.mkdirSync(root);
  const { r, calls } = setup(root);
  r.check();
  assert.equal(calls.length, 0);
  r.restartNow();
  assert.equal(calls.length, 1);
});

test('a git that cannot read HEAD logs once and never stops the hub or restarts it', () => {
  const root = clone();
  const logs = [];
  const calls = [];
  const r = restarter({ root, files: ['hub/hub.mjs'], restart: () => { calls.push(1); return null; }, log: (...a) => logs.push(a.join(' ')), git: () => { throw new Error('git is broken'); } });
  r.check();
  r.check();
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /git is broken/);
});
