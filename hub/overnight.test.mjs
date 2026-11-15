import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = tempDir('overnight-');
process.env.HOME = home;
const { overnightOn, setOvernight, overnightJobs } = await import('./overnight.mjs');
const { sendWakes } = await import('./github.mjs');
const { readSettingsFile, writeSettingsFile } = await import('./push.mjs');
const { DEFAULTS, quietMiddle } = await import('./schedule.mjs');
const { settingsView } = await import('./views.mjs');

const web = path.join(home, '.claude', 'kickflip');
const wakeState = (value) => { fs.mkdirSync(web, { recursive: true }); fs.writeFileSync(path.join(web, 'wake-state.json'), JSON.stringify(value)); };
const t = (h, m = 0, day = 14) => new Date(2026, 9, day, h, m);
const st = (s = DEFAULTS) => ({ settings: s, hold: null, count: 0 });
const quiet = (overnight, s = DEFAULTS, now = t(19)) => JSON.parse(JSON.stringify(settingsView({ now, st: st(s), overnight }).quiet.overnight));

test('every overnight job is on by default, and a toggle off persists beside the other settings', () => {
  writeSettingsFile({ rules: [{ id: 'r1', text: 'keep' }] });
  assert.equal(overnightOn('wake'), true);
  setOvernight('wake', false);
  assert.equal(overnightOn('wake'), false);
  assert.deepEqual(readSettingsFile().overnight, { wake: false });
  assert.deepEqual(readSettingsFile().rules, [{ id: 'r1', text: 'keep' }]);
  setOvernight('wake', true);
  assert.equal(overnightOn('wake'), true);
  assert.equal(readSettingsFile().overnight, undefined, 'on is the default, so nothing is stored');
  assert.throws(() => setOvernight('nope', false), (e) => e.status === 400);
});

test('overnight work starts at the middle of quiet hours, following their start and end', () => {
  assert.equal(quietMiddle(DEFAULTS), '03:00');
  assert.equal(quietMiddle({ quiet: { start: '23:00', end: '07:30' } }), '03:15');
  assert.equal(quietMiddle({ quiet: { start: '01:00', end: '05:00' } }), '03:00');
  assert.equal(quiet([]).starts, 'Starts at 3:00am, the middle of quiet hours.');
});

test("each row reads its job's last run: never grey, ok green, failed red with its link, and off grey", () => {
  const wake = (over) => ({ id: 'wake', title: 'Daily wake', icon: 'calendar', does: (w) => `Wakes every board once at ${w.end}, when quiet hours end.`, on: true, last: null, ...over });
  const [never] = quiet([wake()]).jobs;
  assert.deepEqual(never, { id: 'wake', title: 'Daily wake', icon: 'calendar', sub: 'Wakes every board once at 8:00am, when quiet hours end.', on: true, last: { tone: 'never', text: 'Never run' } });
  const [ok] = quiet([wake({ last: { at: t(8).toISOString(), failed: '' } })]).jobs;
  assert.deepEqual(ok.last, { tone: 'ok', text: 'Last run 8:00am · ok' });
  const [failed] = quiet([wake({ last: { at: t(8).toISOString(), failed: 'failed on alpha', href: '/alpha/' } })]).jobs;
  assert.deepEqual(failed.last, { tone: 'failed', text: 'Last run 8:00am · failed on alpha', href: '/alpha/' });
  const [off] = quiet([wake({ on: false, last: { at: t(8).toISOString(), failed: '' } })]).jobs;
  assert.deepEqual([off.on, off.last], [false, { tone: 'off', text: 'Off' }]);
});

test("the daily wake's row reads its last run from wake-state.json, a run where every board failed included", () => {
  fs.rmSync(path.join(web, 'wake-state.json'), { force: true });
  assert.deepEqual(overnightJobs().map((j) => [j.id, j.on, j.last]), [['wake', true, null]]);
  wakeState({ sent: {}, last: { at: '2026-10-14T08:00:00.000Z', due: ['08:00'], routes: ['a'], failed: [] } });
  assert.deepEqual(overnightJobs()[0].last, { at: '2026-10-14T08:00:00.000Z', failed: '' });
  wakeState({ sent: {}, last: { at: '2026-10-14T08:00:00.000Z', due: ['08:00'], routes: [], failed: ['a', 'b'] } });
  assert.deepEqual(overnightJobs()[0].last, { at: '2026-10-14T08:00:00.000Z', failed: 'failed on a, b' });
});

test('with Daily wake off, the end of quiet hours wakes no board', async () => {
  const dir = path.join(home, 'alpha');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ items: 'data/items.json' }));
  fs.writeFileSync(path.join(dir, 'data/items.json'), JSON.stringify({ items: [] }));
  const manifest = { sites: { alpha: { dir, port: 1, cmd: [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname] } } };
  wakeState({ sent: {} });
  setOvernight('wake', false);
  assert.deepEqual(await sendWakes({ now: t(8, 1), settings: DEFAULTS, manifest }), { due: [], events: [], failed: [] });
  setOvernight('wake', true);
  const woke = await sendWakes({ now: t(8, 1), settings: DEFAULTS, manifest });
  assert.deepEqual([woke.due, woke.events.map((e) => e.route)], [['08:00'], ['alpha']]);
});
