// docs/adr/2026-11-24-0100-a-block-holds-every-transition-and-its-end-moves-the-card-or-opens-a-wait.md
// One block check holds every transition, and every way a block ends goes through one step that moves the card or
// opens one wait. What a block does past Todo otherwise is block-past-todo.test.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boardWith, home, at, site, write, read, lines, wave, itemOf, threadOf } from './board-fixture.mjs';
import * as store from './store.mjs';
import { buildBoard, blockWordsOf, landSkipOf, orchestratorWaits } from './domain.mjs';
import { stageBlockedReady } from './migrations.mjs';

// ---- The waits: stale is a fault only, and a block's end opens the unblocked wait ----
const now = Date.parse('2026-11-22T12:00:00Z');
const stoppedRun = { A1: { main: { kind: 'claude', started: '2026-11-22T10:00:00Z', stopped: { run: 'build', at: '2026-11-22T11:00:00Z' } } } };
const goneRun = { A1: { main: { kind: 'claude', started: '2026-11-22T10:00:00Z', session: { pid: 999999 } } } };
const builtOf = (a1, { agents = stoppedRun, blocker = 'progress', alive = {} } = {}) => buildBoard({ now, alive, files: [{ slug: 'w', agents, itemFile: { internal: true, items: [
  { id: 'A1', title: 'feat: one', lane: 'progress', phase: 'ready', ...a1 }, { id: 'B1', title: 'feat: blocker', lane: blocker, phase: 'ready' }] } }] });
const waitsOf = (built) => orchestratorWaits(built).filter((w) => w.key === 'w/A1').map((w) => w.kind);
const a1Of = (built) => built.items.find((i) => i.key === 'w/A1');

test('a stopped builder on a card blocked by an open task has no wait and never reads stale', () => {
  const built = builtOf({ deps: ['B1'] });
  assert.deepEqual(waitsOf(built), []);
  assert.equal(a1Of(built).stale, false);
  assert.equal(a1Of(builtOf({ held: true })).stale, false, "the owner's block holds it too");
  assert.deepEqual(waitsOf(builtOf({ blocked_until: 'the API ships' })), []);
});

test("once the block ends, a stopped or gone builder's card has the unblocked wait to restart it, not a stale one", () => {
  for (const [name, agents, alive] of [['stopped', stoppedRun, {}], ['gone', goneRun, { 'w/A1': false }]]) {
    const built = builtOf({ deps: ['B1'], unblocked_at: '2026-11-22T11:30:00Z' }, { agents, blocker: 'done', alive });
    const waits = orchestratorWaits(built).filter((w) => w.key === 'w/A1');
    assert.deepEqual(waits.map((w) => w.kind), ['unblocked'], name);
    assert.match(waits[0].next, /^Its block ended and its builder isn't running: restart the build with builder resume w\/A1 --text/);
  }
});

test('a stopped builder with nothing blocking it is stale', () => {
  assert.deepEqual(waitsOf(builtOf({})), ['stale']);
  assert.equal(a1Of(builtOf({})).stale, true);
});

test('a blocker that closed without landing opens a wait to check the task still applies, in Todo too', () => {
  for (const lane of ['todo', 'progress', 'review']) {
    const built = builtOf({ lane, phase: lane === 'todo' ? 'grilling' : 'ready', deps: ['B1'], unblocked_at: '2026-11-22T11:30:00Z', unblock_check: '#9' }, { agents: {}, blocker: 'done' });
    const wait = orchestratorWaits(built).find((w) => w.key === 'w/A1' && w.kind === 'unblocked');
    assert.match(wait?.next ?? '', /^#9 closed without landing, which this task waited on: check it still applies/, lane);
  }
});

test("a blocked staged card has no staging wait; its block's end opens it, owed from then", () => {
  const staged = { lane: 'todo', phase: 'staging', staged_at: '2026-11-22T09:00:00Z' };
  assert.deepEqual(waitsOf(builtOf({ ...staged, deps: ['B1'] }, { agents: {} })), []);
  assert.deepEqual(waitsOf(builtOf({ ...staged, held: true }, { agents: {} })), []);
  const ended = orchestratorWaits(builtOf({ ...staged, deps: ['B1'], unblocked_at: '2026-11-22T11:30:00Z' }, { agents: {}, blocker: 'done' })).find((w) => w.key === 'w/A1');
  assert.deepEqual([ended.kind, ended.since, ended.picked], ['staging', '2026-11-22T11:30:00Z', null]);
});

test("the one block check reads the owner's block beside tasks and a condition, and holds a verified build's land", () => {
  const built = builtOf({ held: true, deps: ['B1'], blocked_until: 'the API ships' }, { agents: {} });
  assert.equal(blockWordsOf(a1Of(built)), 'by the owner and by B1 and until the API ships');
  assert.deepEqual(landSkipOf(a1Of(builtOf({ held: true }, { agents: {} })), null), { step: 'blocked', blocked: 'by the owner' });
});

// ---- The holds and the block's end, through the CLI and the board's taps ----
const waveFile = () => at('waves', 'w', 'wave.json');
const events = () => lines(site('orch', 'data', 'events.jsonl'));
const onOrch = (...args) => boardWith(['--site', 'orch', ...args]);
const notes = () => write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
const items = (a1, b1 = { lane: 'progress' }) => write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', size: 'small', plan: 'a1-notes.md', ...a1 }, { id: 'B1', title: 'feat: blocker', ...b1 }] });
const asHome = (t) => { const old = process.env.HOME; process.env.HOME = home; t.after(() => { process.env.HOME = old; }); };

test('a blocked staged card is refused ready, by a task, a condition or the owner', async () => {
  notes();
  for (const [name, block, words] of [['task', { deps: ['B1'] }, 'by B1'], ['condition', { blocked_until: 'the API ships' }, 'until the API ships'], ['owner', { held: true }, 'by the owner']]) {
    items({ phase: 'staging', staged_at: new Date().toISOString(), ...block });
    const r = await onOrch('item', 'set', 'w/A1', '--phase', 'ready', '--text', 'Checked.');
    assert.equal(r.code, 1, name);
    assert.match(r.err, new RegExp(`w/A1 is blocked ${words}, so it stays staged`), name);
    assert.equal(itemOf().phase, 'staging', name);
  }
});

test('blocking a ready card sends it back to staging, by a task, a condition, or the owner’s Block', async (t) => {
  asHome(t);
  notes();
  const ready = { phase: 'ready', ready_at: new Date().toISOString(), ready_main: 'abc' };
  for (const flags of [['--blocked-by', 'B1'], ['--blocked-until', 'the API ships']]) {
    items(ready);
    fs.rmSync(site('orch', 'data', 'threads'), { recursive: true, force: true });
    const r = await onOrch('item', 'set', 'w/A1', ...flags);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([itemOf().phase, itemOf().ready_at, itemOf().ready_main, Boolean(itemOf().staged_at)], ['staging', undefined, undefined, true], flags[0]);
    assert.ok(threadOf().some((l) => l.command === 'staged'), flags[0]);
  }
  items(ready);
  await store.recordOwnerTap(site('orch'), 'card-hold', { key: 'w/A1', hold: true });
  assert.deepEqual([itemOf().phase, itemOf().held], ['staging', true]);
});

test('editing its blockers so none is open ends the block: a line, unblocked_at and card-unblocked', async () => {
  items({ phase: 'staging', staged_at: new Date().toISOString(), deps: ['B1'] });
  write(site('orch', 'data', 'events.jsonl'), '');
  const r = await onOrch('item', 'set', 'w/A1', '--blocked-by', '');
  assert.equal(r.code, 0, r.err);
  const line = threadOf().find((l) => l.line === 'unblocked');
  assert.equal(line?.text, 'Unblocked: no task blocks it now.');
  assert.equal(itemOf().unblocked_at, line.ts);
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));
});

test("the owner's Unblock, by tap or by its time running out, ends the block like any other", async (t) => {
  asHome(t);
  items({ lane: 'review', pr: 7, held: true });
  write(site('orch', 'data', 'events.jsonl'), '');
  await store.recordOwnerTap(site('orch'), 'card-hold', { key: 'w/A1', hold: false });
  assert.ok(itemOf().unblocked_at);
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));

  const until = new Date(Date.now() - 1000).toISOString();
  items({ lane: 'review', pr: 7, held: true, pick_up_at: until });
  await store.pickUp(site('orch'), 'w/A1', until);
  const ended = threadOf().find((l) => l.line === 'hold-ended');
  assert.deepEqual([itemOf().held, itemOf().unblocked_at], [undefined, ended.ts]);

  // A card still blocked by a task stays blocked: nothing ends.
  items({ lane: 'review', pr: 7, held: true, deps: ['B1'] });
  await store.recordOwnerTap(site('orch'), 'card-hold', { key: 'w/A1', hold: false });
  assert.equal(itemOf().unblocked_at, undefined);
});

test('a blocker that closed without landing unblocks its waiters with a check; one that landed does not ask it', async (t) => {
  asHome(t);
  items({ lane: 'review', pr: 7, deps: ['B1'] });
  assert.equal((await onOrch('item', 'set', 'w/B1', '--done', '--text', 'Dropped: not needed.')).code, 0);
  assert.equal(threadOf().find((l) => l.line === 'unblocked-closed')?.text, 'Unblocked: B1 closed without landing.');
  assert.deepEqual([Boolean(itemOf().unblocked_at), itemOf().unblock_check], [true, 'B1']);

  items({ lane: 'review', pr: 7, deps: ['B1'], unblock_check: 'old' });
  await store.setItem(site('orch'), 'w/B1', { done: true, closing: ['handed-closed', {}], landed: 'abc1234' });
  assert.ok(threadOf().some((l) => l.line === 'unblocked-done'));
  assert.equal(itemOf().unblock_check, undefined);
});

test("a block holds a build's restart and resume on a card already In Progress", async (t) => {
  asHome(t);
  items({ lane: 'progress', phase: 'ready', deps: ['B1'] });
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', kind: 'claude', started: '2026-11-22T10:00:00Z', done: '2026-11-22T10:30:00Z', handed_back: '2026-11-22T10:30:00Z', session: { id: 's1' } });
  await assert.rejects(store.startBuilder(site('orch'), 'w/A1', { kind: 'build', dispatch: 'session' }), { message: /w\/A1 is blocked by B1; its build starts again once nothing blocks it/ });
  await assert.rejects(store.builderResume(site('orch'), 'w/A1', 'Carry on.'), { message: 'A1 is blocked by B1; resume its build once nothing blocks it' });
});

test('the migration moves every ready card a block holds to staging, and leaves the rest', async (t) => {
  asHome(t);
  write(waveFile(), { ...wave(), items: [
    { id: 'A1', title: 'feat: one', phase: 'ready', ready_at: '2026-11-20T10:00:00Z', deps: ['B1'] },
    { id: 'A2', title: 'feat: two', phase: 'ready', held: true },
    { id: 'A3', title: 'feat: three', phase: 'ready' },
    { id: 'B1', title: 'feat: blocker', lane: 'progress' }] });
  assert.deepEqual(await stageBlockedReady(site('orch')), ['w: 2 blocked ready tasks moved to staging']);
  const file = read(waveFile());
  assert.deepEqual(file.items.map((i) => i.phase), ['staging', 'staging', 'ready', undefined]);
  assert.equal(file.items[0].ready_at, undefined);
  assert.deepEqual(await stageBlockedReady(site('orch')), []);
});
