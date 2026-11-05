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

test('an installed version as new as latest offers nothing, and a registry that fails keeps the last answer', async () => {
  const root = install({ version: '0.4.0' });
  let answer = { ok: true, status: 200, json: async () => ({ version: '0.4.0' }) };
  const logs = [];
  const up = upgrader({ root, running: '0.4.0', fetch: async () => answer, run: () => new Promise(() => {}), log: (...a) => logs.push(a.join(' ')) });
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
  const up = upgrader({ root, running: '0.1.0', fetch, run: async () => ({ ok: true }) });
  await up.check();
  assert.deepEqual(asked, []);
  assert.equal(up.state(), null);
  await assert.rejects(up.request(), { status: 409 });
});

// The hub pulls the new version itself, then offers Restart (docs/adr/2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md).
const install2 = (version) => (root) => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@lovek4d/kickflip', version }));

test('a check that finds a newer version pulls it at once, with no builder wait, and then offers Restart until the hub runs it', async () => {
  const root = install({ version: '0.3.0' });
  const runs = [];
  let finish;
  let changes = 0;
  const up = upgrader({ root, running: '0.3.0', fetch: registry('0.4.0').fetch, run: () => { runs.push(1); return new Promise((resolve) => { finish = resolve; }); }, changed: () => changes++ });
  assert.equal(up.state(), null);
  await up.check();
  assert.equal(runs.length, 1);
  assert.deepEqual(up.state(), { state: 'updating', version: '0.4.0' });
  await up.check();
  assert.equal(runs.length, 1);
  install2('0.4.0')(root);
  finish({ ok: true });
  await new Promise(setImmediate);
  assert.deepEqual(up.state(), { state: 'updated', version: '0.4.0' });
  assert.ok(changes >= 2);
  const again = upgrader({ root, running: '0.4.0', fetch: registry('0.4.0').fetch, run: async () => ({ ok: true }) });
  await again.check();
  assert.equal(again.state(), null);
});

test('a version installed on disk newer than the running hub is offered for Restart even before a check', () => {
  const root = install({ version: '0.4.0' });
  const up = upgrader({ root, running: '0.3.0', fetch: registry('0.4.0').fetch, run: async () => ({ ok: true }) });
  assert.deepEqual(up.state(), { state: 'updated', version: '0.4.0' });
});

test('a failed pull shows as failed with its error, a tap pulls again, and the next check retries too', async () => {
  const root = install({ version: '0.3.0' });
  const runs = [];
  let result = { ok: false, error: 'npm update failed' };
  const up = upgrader({ root, running: '0.3.0', fetch: registry('0.4.0').fetch, run: async () => { runs.push(1); return result; } });
  await assert.rejects(up.request(), { status: 409, message: /up to date/ });
  await up.check();
  await new Promise(setImmediate);
  assert.deepEqual(up.state(), { state: 'failed', version: '0.4.0', error: 'npm update failed' });
  result = { ok: false, error: 'still down' };
  await up.request();
  await new Promise(setImmediate);
  assert.equal(runs.length, 2);
  assert.equal(up.state().error, 'still down');
  await up.check();
  await new Promise(setImmediate);
  assert.equal(runs.length, 3);
});

test('a pull that finishes OK calls pulled, and a failed pull does not', async () => {
  const root = install({ version: '0.3.0' });
  let result = { ok: false, error: 'down' };
  let pulled = 0;
  const up = upgrader({ root, running: '0.3.0', fetch: registry('0.4.0').fetch, run: async () => result, pulled: () => pulled++ });
  await up.check();
  await new Promise(setImmediate);
  assert.equal(pulled, 0);
  result = { ok: true };
  await up.request();
  await new Promise(setImmediate);
  assert.equal(pulled, 1);
});
