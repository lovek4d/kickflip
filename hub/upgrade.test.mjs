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

test('an installed version as new as latest pulls nothing, and a registry that fails logs and pulls nothing', async () => {
  const root = install({ version: '0.4.0' });
  let answer = { ok: true, status: 200, json: async () => ({ version: '0.4.0' }) };
  const logs = [];
  let runs = 0;
  const up = upgrader({ root, fetch: async () => answer, run: async () => { runs++; return { ok: true }; }, log: (...a) => logs.push(a.join(' ')) });
  await up.check();
  answer = { ok: false, status: 503, json: async () => ({}) };
  await up.check();
  assert.equal(runs, 0);
  assert.match(logs.join('\n'), /503/);
});

test('a clone never asks npm and never pulls', async () => {
  const root = install({ version: '0.1.0', clone: true });
  const { fetch, asked } = registry('9.0.0');
  let runs = 0;
  const up = upgrader({ root, fetch, run: async () => { runs++; return { ok: true }; } });
  await up.check();
  assert.deepEqual(asked, []);
  assert.equal(runs, 0);
});

// docs/adr/2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md
test('a check that finds a newer version pulls it at once, once while it runs, and calls pulled only when the pull finished OK', async () => {
  const root = install({ version: '0.3.0' });
  let finish;
  const runs = [];
  let pulled = 0;
  const up = upgrader({ root, fetch: registry('0.4.0').fetch, run: () => { runs.push(1); return new Promise((resolve) => { finish = resolve; }); }, pulled: () => pulled++ });
  await up.check();
  await up.check();
  assert.equal(runs.length, 1);
  finish({ ok: false, error: 'down' });
  await new Promise(setImmediate);
  assert.equal(pulled, 0);
  await up.check();
  assert.equal(runs.length, 2);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  finish({ ok: true });
  await new Promise(setImmediate);
  assert.equal(pulled, 1);
});

test('a pull that finishes OK but leaves the installed version where it was logs both versions, does not call pulled and retries at the next check', async () => {
  const root = install({ version: '0.6.0' });
  const logs = [];
  let runs = 0;
  let pulled = 0;
  const up = upgrader({ root, fetch: registry('0.6.1').fetch, run: async () => { runs++; return { ok: true }; }, pulled: () => pulled++, log: (...a) => logs.push(a.join(' ')) });
  await up.check();
  await new Promise(setImmediate);
  await up.check();
  await new Promise(setImmediate);
  assert.equal(runs, 2);
  assert.equal(pulled, 0);
  assert.deepEqual(logs, ['update left v0.6.0; npm has 0.6.1', 'update left v0.6.0; npm has 0.6.1']);
});
