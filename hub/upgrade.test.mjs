import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AWAY_MS, CHECK_MS, LATEST_URL, PULL_MS, newer, upgrader } from './upgrade.mjs';

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
  assert.deepEqual(logs, ['kickflip update check: npm 0.6.1, running 0.6.0', 'kickflip update left v0.6.0; npm has 0.6.1', 'kickflip update left v0.6.0; npm has 0.6.1']);
});

// docs/adr/2026-11-10-1140-tapping-the-hub-pages-version-checks-npm-now.md
test('check answers what it found: clone, same, pulling (also while a pull runs) or failed', async () => {
  const clone = upgrader({ root: install({ clone: true }), fetch: registry('9.0.0').fetch, run: async () => ({ ok: true }) });
  assert.deepEqual(await clone.check(), { state: 'clone' });

  const root = install({ version: '0.4.0' });
  let answer = registry('0.4.0').fetch;
  let finish;
  const up = upgrader({ root, fetch: (...a) => answer(...a), run: () => new Promise((resolve) => { finish = resolve; }) });
  assert.deepEqual(await up.check(), { state: 'same', latest: '0.4.0' });
  answer = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.deepEqual(await up.check(), { state: 'failed', error: 'npm answered 503' });
  answer = registry('0.5.0').fetch;
  assert.deepEqual(await up.check(), { state: 'pulling', latest: '0.5.0' });
  assert.deepEqual(await up.check(), { state: 'pulling', latest: '0.5.0' });
  finish({ ok: false, error: 'down' });
});

// docs/adr/2026-11-12-0110-the-npm-check-rides-the-hubs-tick-every-15-wall-clock-minutes.md
test('tick checks when none has run, then again only 15 wall-clock minutes after the last check began, a tap included', async () => {
  const root = install({ version: '0.4.0' });
  const { fetch, asked } = registry('0.4.0');
  let clock = 0;
  const up = upgrader({ root, fetch, run: async () => ({ ok: true }), now: () => clock });
  await up.tick();
  assert.equal(asked.length, 1);
  clock = CHECK_MS - 1;
  await up.tick();
  assert.equal(asked.length, 1);
  clock = CHECK_MS;
  await up.tick();
  assert.equal(asked.length, 2);
  clock += 10 * 60_000;
  await up.check();
  clock += CHECK_MS - 1;
  await up.tick();
  assert.equal(asked.length, 3);
  clock += 1;
  await up.tick();
  assert.equal(asked.length, 4);
  assert.equal(CHECK_MS, 15 * 60_000);
});

test('each check logs npm and the running version when the answer changes, and otherwise at most once an hour', async () => {
  const root = install({ version: '0.7.1' });
  let version = '0.7.1';
  let clock = 0;
  const logs = [];
  const up = upgrader({ root, fetch: async () => ({ ok: true, status: 200, json: async () => ({ version }) }), run: () => new Promise(() => {}), log: (...a) => logs.push(a.join(' ')), now: () => clock });
  await up.check();
  clock += 15 * 60_000;
  await up.check();
  clock += 30 * 60_000;
  await up.check();
  assert.deepEqual(logs, ['kickflip update check: npm 0.7.1, running 0.7.1']);
  clock += 15 * 60_000;
  await up.check();
  assert.equal(logs.length, 2);
  version = '0.7.2';
  clock += 1;
  await up.check();
  assert.deepEqual(logs.slice(2), ['kickflip update check: npm 0.7.2, running 0.7.1']);
});

test('a pull that has not finished in 10 minutes is aborted, logged and retried at the next check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = install({ version: '0.7.1' });
  const logs = [];
  const signals = [];
  const up = upgrader({
    root, fetch: registry('0.7.2').fetch, log: (...a) => logs.push(a.join(' ')),
    run: ({ signal }) => { signals.push(signal); return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, error: 'killed' }))); },
  });
  await up.check();
  await up.check();
  assert.equal(signals.length, 1);
  t.mock.timers.tick(PULL_MS - 1);
  assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signals[0].aborted, true);
  await new Promise(setImmediate);
  assert.match(logs.join('\n'), /kickflip update killed after 10 minutes/);
  await up.check();
  assert.equal(signals.length, 2);
  assert.equal(PULL_MS, 10 * 60_000);
});

// docs/adr/2026-11-12-0300-an-npm-hub-pulls-only-once-the-owner-has-been-away-15-minutes.md
test('a tick that finds a newer version holds the pull until the owner has been away 15 minutes, and a tap pulls at once', async () => {
  const root = install({ version: '0.7.1' });
  let clock = 0;
  let awayFor = 0;
  let runs = 0;
  const up = upgrader({ root, fetch: registry('0.7.2').fetch, run: async () => { runs++; return { ok: true }; }, now: () => clock, awayFor: () => awayFor });
  await up.tick();
  assert.equal(runs, 0);
  clock += 5_000;
  awayFor = AWAY_MS - 1;
  await up.tick();
  assert.equal(runs, 0);
  awayFor = AWAY_MS;
  await up.tick();
  assert.equal(runs, 1);
  assert.equal(AWAY_MS, 15 * 60_000);

  const tapped = upgrader({ root, fetch: registry('0.7.2').fetch, run: async () => { runs++; return { ok: true }; }, awayFor: () => 0 });
  assert.deepEqual(await tapped.check(), { state: 'pulling', latest: '0.7.2' });
  assert.equal(runs, 2);
});

test('a tick that finds a newer version while the owner has been away 15 minutes pulls at once, and a held pull is dropped once the install is current', async () => {
  const root = install({ version: '0.7.1' });
  let awayFor = AWAY_MS;
  let runs = 0;
  const up = upgrader({ root, fetch: registry('0.7.2').fetch, run: async () => { runs++; return { ok: true }; }, awayFor: () => awayFor });
  await up.tick();
  assert.equal(runs, 1);

  const held = install({ version: '0.7.1' });
  awayFor = 0;
  const waiting = upgrader({ root: held, fetch: registry('0.7.2').fetch, run: async () => { runs++; return { ok: true }; }, awayFor: () => awayFor });
  await waiting.tick();
  fs.writeFileSync(path.join(held, 'package.json'), JSON.stringify({ version: '0.7.2' }));
  awayFor = AWAY_MS;
  await waiting.tick();
  assert.equal(runs, 1);
});

// docs/adr/2026-11-13-2345-a-checkbox-under-the-hubs-version-turns-auto-update-off.md
test('with auto update off a tick still finds the newer version and names it but never pulls, and a tap pulls once', async () => {
  const root = install({ version: '0.7.1' });
  let auto = false;
  let runs = 0;
  const up = upgrader({ root, fetch: registry('0.7.2').fetch, run: async () => { runs++; return { ok: true }; }, awayFor: () => AWAY_MS, autoUpdate: () => auto });
  assert.equal(up.available(), null);
  await up.tick();
  await up.tick();
  assert.equal(runs, 0);
  assert.equal(up.available(), '0.7.2');
  auto = true;
  await up.tick();
  assert.equal(runs, 1, 'turned back on, the held version pulls under the usual rule');

  auto = false;
  const tapped = upgrader({ root: install({ version: '0.7.1' }), fetch: registry('0.7.2').fetch, run: async () => { runs++; return { ok: true }; }, autoUpdate: () => auto });
  assert.deepEqual(await tapped.check(), { state: 'pulling', latest: '0.7.2' });
  assert.equal(runs, 2);
});

test('available names nothing while the install is current, and a clone says it is one', async () => {
  const same = upgrader({ root: install({ version: '0.7.2' }), fetch: registry('0.7.2').fetch, run: async () => ({ ok: true }) });
  await same.check();
  assert.equal(same.available(), null);
  assert.equal(same.clone, false);
  assert.equal(upgrader({ root: install({ clone: true }), fetch: registry('9.0.0').fetch, run: async () => ({ ok: true }) }).clone, true);
});
