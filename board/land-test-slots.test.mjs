import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { boundedTests, holdingTestSlot, moveQueuedLand } from './worktree.mjs';
import { MAX_LAND_TESTS, readLandTests, setLandTests } from '../shared/hub-settings.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

function home(t) {
  const dir = tempDir('land-test-slots-');
  const old = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; });
  return dir;
}
const gate = () => { let open; const opened = new Promise((r) => { open = r; }); return { opened, open }; };
// A run that holds its slot until its gate opens; started resolves once it holds the slot.
function held(card, opts) {
  const started = gate(), release = gate();
  const done = holdingTestSlot(card, async () => { started.open(); await release.opened; }, opts);
  return { started: started.opened, release: release.open, done };
}
// A run that waits for a slot; waits resolves with the card it waits for.
function waiting(card, opts, order) {
  const waits = gate();
  const done = holdingTestSlot(card, async () => { order?.push(card); }, { ...opts, onWait: (who) => waits.open(who) });
  return { waits: waits.opened, done };
}

// docs/adr/2026-11-16-0700-land-test-runs-take-turns-on-the-host.md
test('land test runs go one at a time by default, in the order asked, each saying whom it waits for', async (t) => {
  home(t);
  const order = [];
  const first = held('#1', { slots: 1 });
  await first.started;
  const second = waiting('#2', { slots: 1 }, order);
  assert.equal(await second.waits, '#1');
  const third = waiting('#3', { slots: 1 }, order);
  assert.equal(await third.waits, '#2');
  first.release();
  await Promise.all([first.done, second.done, third.done]);
  assert.deepEqual(order, ['#2', '#3']);
});

test('a setting of two lets two run at once and holds the third', async (t) => {
  home(t);
  const one = held('#1', { slots: 2 });
  const two = held('#2', { slots: 2 });
  await Promise.all([one.started, two.started]);
  const third = waiting('#3', { slots: 2 });
  await third.waits;
  one.release();
  two.release();
  await Promise.all([one.done, two.done, third.done]);
});

test('a bumped land test run goes ahead of the ones asked before it', async (t) => {
  home(t);
  const order = [];
  const first = held('#1', { slots: 1 });
  await first.started;
  const second = waiting('#2', { slots: 1, site: '/s', key: 'w/2' }, order);
  await second.waits;
  const third = waiting('#3', { slots: 1, site: '/s', key: 'w/3' }, order);
  await third.waits;
  assert.equal(moveQueuedLand('/s', 'w/3', '2026-11-16T10:00:00.000Z'), 1);
  first.release();
  await Promise.all([first.done, second.done, third.done]);
  assert.deepEqual(order, ['#3', '#2']);
});

test('a slot held by a process that is gone is taken over', async (t) => {
  const dir = home(t);
  const running = path.join(dir, '.claude', 'kickflip', 'landtest.running');
  fs.mkdirSync(running, { recursive: true });
  fs.writeFileSync(path.join(running, `000000000000001-000000-${2 ** 22 + 1}`), JSON.stringify({ card: '#9' }));
  let ran = false;
  await holdingTestSlot('#5', async () => { ran = true; }, { slots: 1 });
  assert.equal(ran, true);
  assert.deepEqual(fs.readdirSync(running), []);
});

test('boundedTests takes a slot around whatever runTests is and returns its result', async (t) => {
  home(t);
  const first = held('#1', { slots: 1 });
  await first.started;
  const waits = gate();
  const result = boundedTests(async (files) => ({ ok: true, files }), '#2', { slots: 1, onWait: (who) => waits.open(who) })(['a.test.mjs']);
  assert.equal(await waits.opened, '#1');
  first.release();
  assert.deepEqual(await result, { ok: true, files: ['a.test.mjs'] });
  await first.done;
});

test("the setting is the hub's one number: 1 unless it is saved as 1 to 99, whichever board saves or reads it", async (t) => {
  const dir = home(t);
  assert.equal(MAX_LAND_TESTS, 1);
  assert.equal(readLandTests(dir), 1);
  assert.equal(await setLandTests('3', dir), 3);
  assert.equal(readLandTests(dir), 3);
  await assert.rejects(() => setLandTests('0', dir), { status: 400 });
  await assert.rejects(() => setLandTests('100', dir), { status: 400 });
  await assert.rejects(() => setLandTests('1.5', dir), { status: 400 });
  assert.equal(readLandTests(dir), 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kickflip', 'settings.json'), 'utf8')).landTests, 3);
});
