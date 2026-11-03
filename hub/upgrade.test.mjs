import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LATEST_URL, newer, upgrader } from './upgrade.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-unit-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function install({ version = '0.3.0', clone = false } = {}) {
  const root = path.join(scratch, `kickflip-${n++}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@lovek4d/kickflip', version }));
  if (clone) fs.mkdirSync(path.join(root, '.git'));
  return root;
}
const registry = (version) => {
  const asked = [];
  const fetch = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ name: '@lovek4d/kickflip', version }) }; };
  return { fetch, asked };
};

test('newer compares versions by their numbers', () => {
  assert.equal(newer('0.3.1', '0.3.0'), true);
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('1.0.0', '0.99.0'), true);
  assert.equal(newer('0.3.0', '0.3.0'), false);
  assert.equal(newer('0.2.9', '0.3.0'), false);
});

test('an npm install offers the update once @lovek4d/kickflip@latest is newer than the installed version', async () => {
  const root = install({ version: '0.3.0' });
  const { fetch, asked } = registry('0.4.0');
  let changes = 0;
  const up = upgrader({ root, fetch, builders: async () => [], run: async () => ({ ok: true }), changed: () => changes++ });
  assert.equal(up.state(), null);
  await up.check();
  assert.deepEqual(asked, [LATEST_URL]);
  assert.deepEqual(up.state(), { state: 'available', version: '0.4.0' });
  assert.equal(changes, 1);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  assert.equal(up.state(), null);
});

test('an installed version as new as latest offers nothing, and a registry that fails keeps the last answer', async () => {
  const root = install({ version: '0.4.0' });
  let answer = { ok: true, status: 200, json: async () => ({ version: '0.4.0' }) };
  const logs = [];
  const up = upgrader({ root, fetch: async () => answer, builders: async () => [], run: async () => ({ ok: true }), log: (...a) => logs.push(a.join(' ')) });
  await up.check();
  assert.equal(up.state(), null);
  answer = { ok: true, status: 200, json: async () => ({ version: '0.5.0' }) };
  await up.check();
  assert.equal(up.state().version, '0.5.0');
  answer = { ok: false, status: 503, json: async () => ({}) };
  await up.check();
  assert.equal(up.state().version, '0.5.0');
  assert.match(logs.join('\n'), /503/);
});

test('a clone never asks npm and never shows the update', async () => {
  const root = install({ version: '0.1.0', clone: true });
  const { fetch, asked } = registry('9.0.0');
  const up = upgrader({ root, fetch, builders: async () => [], run: async () => ({ ok: true }) });
  await up.check();
  assert.deepEqual(asked, []);
  assert.equal(up.state(), null);
  await assert.rejects(up.request(), { status: 409 });
});

test('a tap runs kickflip update at once when no builder runs', async () => {
  const root = install();
  const runs = [];
  let finish;
  const up = upgrader({ root, fetch: registry('0.4.0').fetch, builders: async () => [], run: () => { runs.push(1); return new Promise((resolve) => { finish = resolve; }); } });
  await assert.rejects(up.request(), { status: 409, message: /up to date/ });
  await up.check();
  assert.deepEqual(await up.request(), { state: 'updating', version: '0.4.0' });
  assert.equal(runs.length, 1);
  assert.deepEqual(await up.request(), { state: 'updating', version: '0.4.0' });
  await up.tick();
  assert.equal(runs.length, 1);
  finish({ ok: false, error: 'npm update failed' });
  await new Promise(setImmediate);
  assert.deepEqual(up.state(), { state: 'failed', version: '0.4.0', error: 'npm update failed' });
  await up.request();
  assert.equal(runs.length, 2);
});

test('the update waits until no builder runs, counting them, then runs', async () => {
  const root = install();
  let running = [{ key: 'hub/GH-1' }, { key: 'shop/INT-2' }];
  const runs = [];
  let changes = 0;
  const up = upgrader({ root, fetch: registry('0.4.0').fetch, builders: async () => running, run: () => { runs.push(1); return new Promise(() => {}); }, changed: () => changes++ });
  await up.check();
  assert.deepEqual(await up.request(), { state: 'waiting', version: '0.4.0', builders: 2 });
  running = [running[0]];
  await up.tick();
  assert.deepEqual(up.state(), { state: 'waiting', version: '0.4.0', builders: 1 });
  assert.equal(runs.length, 0);
  running = [];
  const before = changes;
  await up.tick();
  assert.equal(runs.length, 1);
  assert.equal(up.state().state, 'updating');
  assert.ok(changes > before);
});
