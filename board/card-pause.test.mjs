// #432: a blocked (by tasks, a condition or the owner), usage-limited or bumped-out card pauses its builder at the next stopping point and stays In
// Progress (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { boardWith, home, at, site, write, read, run, runAsync, itemOf, threadOf, record, onHome, pollClock } from './board-fixture.mjs';
import * as store from './store.mjs';
import { pullOf, pauseWork, confirmedDrops, PAUSE_HARD_STOP } from './domain.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const now = () => new Date().toISOString();
const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const onOrch = (...args) => boardWith(['--site', 'orch', ...args]);
const texts = () => threadOf().filter((l) => l.kind !== 'status').map((l) => l.text);

// A headless builder as the board launches one: a detached process leading its own group.
async function fakeBuilder(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  await once(child, 'spawn');
  return child.pid;
}
const tree = () => ({ path: path.join(home, 'tree'), branch: 'A1', repo: path.join(home, 'repo') });
function building(pid = null) {
  setA1({ lane: 'progress', phase: 'ready' });
  write(recordFile(), { started: new Date(Date.now() - 60_000).toISOString(), kind: 'claude', model: 'opus', worktree: tree(), ...(pid ? { session: { id: 's1', pid, at: now() } } : {}) });
}

test("blocking a card In Progress asks its builder to pause: the card stays In Progress, its builder runs on and its record stays open", async (t) => {
  const pid = await fakeBuilder(t);
  building(pid);
  const r = await runAsync('board.mjs', ['--site', 'orch', 'item', 'set', 'w/A1', '--deps', 'ENG-1']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([itemOf().lane, itemOf().deps], ['progress', ['ENG-1']]);
  assert.ok(alive(pid), 'nothing stops it at once');
  const rec = record();
  assert.equal(rec.done, undefined);
  assert.deepEqual([rec.pause.cause, rec.pause.words, rec.pause.paused], ['blocked', 'blocked by ENG-1', undefined]);
  assert.deepEqual(texts(), ['Blocked by ENG-1: its builder pauses at its next stopping point and it stays In Progress.']);
});

test("a session's own builder is paused the same way, not refused", async () => {
  building();
  const r = await onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1');
  assert.equal(r.code, 0, r.err);
  assert.equal(record().pause.cause, 'blocked');
  assert.equal(itemOf().lane, 'progress');
});

test("the builder's next progress report is its stopping point: the reply tells it to commit and stop, and the card reads paused at its phase", async () => {
  building();
  assert.equal((await onOrch('builder', 'progress', 'w/A1', '--phase', 'building', 'Writing the limiter test')).code, 0);
  assert.equal((await onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1')).code, 0);
  const r = await onOrch('builder', 'progress', 'w/A1', '--phase', 'building', 'Writing the limiter code');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Paused: blocked by ENG-1\. Commit what you have now .*then stop: end your turn and run nothing else\. The board resumes this session, telling it so, once the pause clears\./);
  const { pause } = record();
  assert.deepEqual([pause.phase, typeof pause.paused], ['building', 'string']);
  assert.equal(texts().at(-1), 'Paused at building: blocked by ENG-1. It resumes once nothing blocks it.');
  // A second report from a builder that didn't stop says the same, with no second line.
  assert.match((await onOrch('builder', 'progress', 'w/A1', '--phase', 'building', 'Still going')).out, /Paused: blocked by ENG-1/);
  assert.equal(texts().filter((l) => l.startsWith('Paused')).length, 1);
});

test('a call or an ask is a stopping point too, and the call or ask is still recorded', async () => {
  building();
  assert.equal((await onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1')).code, 0);
  const call = await onOrch('builder', 'call', 'w/A1', 'Kept the old name');
  assert.equal(call.code, 0, call.err);
  assert.match(call.out, /judgment call recorded on A1\nPaused: blocked by ENG-1/);
  assert.deepEqual(record().calls.map((c) => c.text), ['Kept the old name']);
  assert.ok(record().pause.paused);
  assert.equal(texts().at(-1), 'Paused: blocked by ENG-1. It resumes once nothing blocks it.', 'a build with no phase line yet pauses with no phase');

  write(recordFile(), { ...record(), pause: { cause: 'held', words: 'blocked', at: now() } });
  const ask = await onOrch('builder', 'ask', 'w/A1', 'Which name?');
  assert.equal(ask.code, 0, ask.err);
  assert.match(ask.out, /Paused: blocked\. Commit/);
});

test("a builder waiting on its ask is already at a stopping point, so builder asks --wait returns the pause at once", async (t) => {
  onHome(t);
  building();
  assert.equal((await onOrch('builder', 'ask', 'w/A1', 'Which name?')).code, 0);
  const { now, checked } = pollClock(t);
  const waiting = store.listAsks(site('orch'), 'w/A1', { wait: true, now });
  await checked();
  assert.equal((await onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1')).code, 0);
  t.mock.timers.tick(2000);
  const { lines } = await waiting;
  assert.match(lines.join('\n'), /Paused: blocked by ENG-1/);
  assert.ok(record().pause.paused);
});

test('a card whose pause cause clears resumes: the record drops its pause and the thread says so', async (t) => {
  onHome(t);
  building();
  assert.equal((await onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1')).code, 0);
  assert.equal((await onOrch('builder', 'progress', 'w/A1', '--phase', 'reading', 'Reading')).code, 0);
  await store.resumePaused(site('orch'), 'w/A1');
  assert.equal(record().pause, undefined);
  assert.equal(texts().at(-1), 'Resumed: nothing blocks it.');
  assert.equal(record().done, undefined);
});

test('a pause whose cause clears before the builder stops is dropped with no line', async (t) => {
  onHome(t);
  building();
  assert.equal((await onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1')).code, 0);
  await store.dropPause(site('orch'), 'w/A1');
  assert.equal(record().pause, undefined);
  assert.equal(texts().filter((l) => /Paused|Resumed/.test(l)).length, 0);
});

test('the hard stop after 15 minutes marks the build paused at its phase', async (t) => {
  onHome(t);
  building();
  assert.equal((await onOrch('builder', 'progress', 'w/A1', '--phase', 'checking', 'The diff')).code, 0);
  write(recordFile(), { ...record(), pause: { cause: 'usage', words: 'usage limit', at: now() } });
  await store.markPaused(site('orch'), 'w/A1');
  assert.deepEqual([record().pause.phase, Boolean(record().pause.paused)], ['checking', true]);
  assert.equal(texts().at(-1), 'Paused at checking: usage limit. It resumes once the usage pause lifts.');
  assert.equal(PAUSE_HARD_STOP, 15 * 60_000);
});

// docs/adr/2026-11-09-1300-…: what the board does each pass, from the built cards.
const card = (key, fields = {}, agent = {}) => ({ key, lane: 'progress', kind: 'work', blocked: false, ownerBlock: null, ...fields,
  agents: [{ name: 'main', kind: 'claude', label: 'Builder', started: '2026-11-09T10:00:00.000Z', done: null, pid: 1, ...agent }] });
// The owner's block, as the built card carries it (docs/adr/2026-11-15-2230-the-owners-hold-is-a-block.md).
const OWNER_BLOCKED = { ownerBlock: { until: null }, blocked: true };

test('pauseWork asks every running build to pause while usage holds its kind, and a paused one resumes once its cause clears', async () => {
  const at = Date.parse('2026-11-09T12:00:00.000Z');
  const items = [
    card('w/A', {}),
    card('w/B', { blocked: true }, { pause: { cause: 'blocked', at: '2026-11-09T11:00:00.000Z', paused: '2026-11-09T11:01:00.000Z' } }),
    card('w/C', {}, { pause: { cause: 'blocked', at: '2026-11-09T11:00:00.000Z', paused: '2026-11-09T11:01:00.000Z' } }),
    card('w/D', OWNER_BLOCKED, { pause: { cause: 'held', at: '2026-11-09T11:50:00.000Z' } }),
    card('w/E', {}, { pause: { cause: 'held', at: '2026-11-09T11:50:00.000Z' } }),
    card('w/F', OWNER_BLOCKED, { pause: { cause: 'held', at: '2026-11-09T11:30:00.000Z' } }),
    card('w/G', {}, { pause: { cause: 'bumped', at: '2026-11-09T10:30:00.000Z', paused: '2026-11-09T10:40:00.000Z' } }),
    card('w/H', {}, { pause: { cause: 'usage', until: '2026-11-09T13:00:00.000Z', at: '2026-11-09T11:00:00.000Z', paused: '2026-11-09T11:00:00.000Z' } }),
    card('w/L', { builder: { phase: 'landing' } }),
    card('w/P', {}, { kind: 'grill' }),
  ];
  assert.deepEqual(pauseWork(items, { now: at, usageHeld: () => false }), { ask: [], drop: ['w/E'], stop: ['w/F'], resume: ['w/G', 'w/C'] });
  assert.deepEqual(pauseWork(items, { now: at, usageHeld: () => true }).ask, ['w/A'], 'a build already pausing, a landing one and a planner are left');
  assert.deepEqual(pauseWork(items, { now: Date.parse('2026-11-09T13:00:00.000Z'), usageHeld: () => false }).resume, ['w/G', 'w/H', 'w/C'], 'oldest pause first');
});

// docs/adr/2026-11-10-1400-the-auto-pass-re-reads-a-pause-before-dropping-it.md
test("a pause the auto pass would drop stands unless a fresh read drops it too: the Block's two writes can straddle the snapshot", async () => {
  const usageHeld = () => false;
  const pause = { cause: 'held', at: '2026-11-09T11:50:00.000Z' };
  const stale = [card('w/A', {}, { pause }), card('w/B', {}, { pause })];
  const fresh = [card('w/A', OWNER_BLOCKED, { pause }), card('w/B', {}, { pause })];
  assert.deepEqual(pauseWork(stale, { usageHeld }).drop, ['w/A', 'w/B'], 'the snapshot read A\'s record after the Block, its item file before it');
  assert.deepEqual(confirmedDrops(pauseWork(stale, { usageHeld }).drop, fresh, { usageHeld }), ['w/B'], 'A is blocked on the fresh read, so its pause stays');
});

// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md
test('a paused build keeps its card\'s implementer slot, since the card stays In Progress', () => {
  const paused = card('w/A', {}, { pause: { cause: 'blocked', at: now(), paused: now() } });
  const pausing = card('w/B', {}, { pause: { cause: 'held', at: now() } });
  assert.equal(pullOf([paused, pausing], { cap: 2 }).free, 0);
});

test('a bump-out pause from before slots counted cards drops once nothing else pauses it', () => {
  const pausing = card('w/B', {}, { pause: { cause: 'bumped', at: '2026-11-09T11:59:00.000Z' } });
  assert.deepEqual(pauseWork([pausing], { now: Date.parse('2026-11-09T12:00:00.000Z'), usageHeld: () => false }).drop, ['w/B']);
});
