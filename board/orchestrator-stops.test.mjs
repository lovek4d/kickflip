// #290: the orchestrator stops the board's own runs, and a bump orders the land queue
// (docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { home, at, site, write, read, lines, runAsync, board } from './board-fixture.mjs';
import { until } from '../shared/test-helpers.mjs';
import { stopRuns, reviveBuilders } from './headless.mjs';
import { holdingLandLock, moveQueuedLand, landQueue } from './worktree.mjs';
import { buildBoard, stoppedWords } from './domain.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const kick = (...p) => at('kickflip', ...p);

// A run as the board starts one: a detached process (its own group) whose land, run in it (nested) or as the run itself,
// starts a detached suite in a group of its own, as worktree.mjs nodeTests does. → {root, land, suite}
async function fakeRun(t, { nested = false } = {}) {
  const script = path.join(home, 'run.mjs');
  write(script, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    'const [out, role] = process.argv.slice(2);',
    "if (role === 'agent') spawn(process.execPath, [process.argv[1], out, 'land'], { stdio: 'ignore' });",
    "else { const suite = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); fs.writeFileSync(out, JSON.stringify({ land: process.pid, suite: suite.pid })); }",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const out = path.join(home, `pids-${Math.random().toString(36).slice(2)}.json`);
  const root = spawn(process.execPath, [script, out, nested ? 'agent' : 'land'], { detached: true, stdio: 'ignore' });
  await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}'), 'the fake run starts its suite');
  const pids = { root: root.pid, ...JSON.parse(fs.readFileSync(out, 'utf8')) };
  t.after(() => { for (const pid of Object.values(pids)) try { process.kill(pid, 'SIGKILL'); } catch {} });
  return pids;
}

const now = () => new Date().toISOString();
const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const thread = () => (fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')) ? lines(site('orch', 'data', 'threads', 'w__A1.jsonl')) : []);
const cli = (...args) => runAsync('board.mjs', ['--site', 'orch', ...args]);

test('stopRuns stops each run with every process group under it, a detached suite too, and names what it stopped', async (t) => {
  const run = await fakeRun(t, { nested: true });
  const stopped = await stopRuns([run.root]);
  assert.deepEqual(new Set(stopped.map((p) => p.pid)), new Set([run.root, run.land, run.suite]));
  assert.ok(stopped.every((p) => typeof p.args === 'string' && p.args.length));
  await until(() => !alive(run.land) && !alive(run.suite), 'the land and its suite are gone');
});

test('stopRuns kills what ignores the stop once the grace period ends', async (t) => {
  const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(stubborn.pid, 'SIGKILL'); } catch {} });
  await sleep(200);
  const gone = new Promise((resolve) => stubborn.once('exit', (code, signal) => resolve(signal)));
  await stopRuns([stubborn.pid], { grace: 300 });
  assert.equal(await gone, 'SIGKILL');
});

test("the orchestrator's builder stop stops the card's headless builder with everything under it, marks its record, and says so in the status word's own words", async (t) => {
  const run = await fakeRun(t, { nested: true });
  setA1({ lane: 'progress' });
  const started = new Date(Date.now() - 60_000).toISOString();
  write(recordFile(), { started, kind: 'claude', model: 'opus', session: { id: 's1', pid: run.root, at: now() } });
  const r = await cli('builder', 'stop', 'w/A1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: build stopped by orchestrator\n/);
  assert.match(r.out, new RegExp(`stopped ${run.root} `));
  assert.match(r.out, new RegExp(`stopped ${run.suite} `));
  await until(() => ![run.root, run.land, run.suite].some(alive), 'the builder and its suite are gone');
  const record = read(recordFile());
  assert.equal(record.stopped.run, 'build');
  assert.ok(record.stopped.at >= started);
  assert.equal(record.done, undefined, 'the record stays open, so the card stays In Progress');
  assert.deepEqual(thread().map((l) => [l.who, l.text]), [['claude', 'build stopped by orchestrator']]);
  // Nothing left to stop.
  const again = await cli('builder', 'stop', 'w/A1');
  assert.equal(again.code, 1);
  assert.match(again.err, /^A1's builder isn't running/);
});

test('builder stop names its run land while the builder is landing, and refuses a run the board did not launch or a planner', async (t) => {
  const run = await fakeRun(t);
  setA1({ lane: 'progress' });
  write(recordFile(), { started: now(), kind: 'claude', session: { pid: run.root, at: now() } });
  write(site('orch', 'data', 'threads', 'w__A1.jsonl'), JSON.stringify({ ts: now(), who: 'claude', kind: 'status', phase: 'landing', text: 'Landing: rebasing onto main and landing' }) + '\n');
  const r = await cli('builder', 'stop', 'w/A1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: land stopped by orchestrator\n/);
  assert.equal(read(recordFile()).stopped.run, 'land');

  write(recordFile(), { started: now(), kind: 'claude' });
  const session = await cli('builder', 'stop', 'w/A1');
  assert.equal(session.code, 1);
  assert.match(session.err, /^A1's builder wasn't launched by the board/);

  write(recordFile(), { started: now(), kind: 'grill', session: { pid: run.root, at: now() } });
  const planner = await cli('builder', 'stop', 'w/A1');
  assert.equal(planner.code, 1);
  assert.match(planner.err, /^A1 has a grill planner running, not a build/);

  // A pid that has since been reused: its process started more than a minute before the session was recorded.
  const other = await fakeRun(t);
  write(recordFile(), { started: now(), kind: 'claude', session: { pid: other.root, at: new Date(Date.now() + 10 * 60_000).toISOString() } });
  const reused = await cli('builder', 'stop', 'w/A1');
  assert.equal(reused.code, 1);
  assert.match(reused.err, /^A1's builder isn't running/);
  assert.ok(alive(other.root));
});

test("land stop on the Merge tap's land stops it and its suite, takes it out of the land queue, and the card's Merge shows again", async (t) => {
  const run = await fakeRun(t);
  setA1({ merge_ready: { branch: 'A1', at: '2026-11-05T10:00:00.000Z', tapped: '2026-11-05T11:00:00.000Z' } });
  write(kick('landing', 'A1'), { pid: run.land, at: now(), merge: true });
  write(kick('land.queue', `${String(Date.now()).padStart(15, '0')}-000000-${run.land}`), { card: 'A1' });
  const r = await cli('land', 'stop', 'w/A1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: land stopped by orchestrator\n/);
  await until(() => !alive(run.land) && !alive(run.suite), 'the land and its suite are gone');
  assert.equal(fs.existsSync(kick('landing', 'A1')), false);
  assert.deepEqual(fs.readdirSync(kick('land.queue')), []);
  const item = read(waveFile()).items.find((i) => i.id === 'A1');
  assert.ok(item.merge_ready.stopped > item.merge_ready.tapped);
  assert.deepEqual(thread().map((l) => l.text), ['land stopped by orchestrator']);
  const again = await cli('land', 'stop', 'w/A1');
  assert.equal(again.code, 1);
  assert.match(again.err, /^A1 has no land running/);
});

test("land stop on a headless builder's land stops that builder, and refuses a land that is fast-forwarding main or runs in a session the board did not launch", async (t) => {
  const run = await fakeRun(t, { nested: true });
  setA1({ lane: 'progress' });
  write(recordFile(), { started: now(), kind: 'claude', session: { pid: run.root, at: now() } });
  write(kick('landing', 'A1'), { pid: run.land, at: now() });
  write(kick('land.lock'), { card: 'A1', pid: run.land, at: now() });
  const locked = await cli('land', 'stop', 'w/A1');
  assert.equal(locked.code, 1);
  assert.match(locked.err, /^A1 is fast-forwarding main now/);
  assert.ok(alive(run.land));
  fs.rmSync(kick('land.lock'));

  write(recordFile(), { started: now(), kind: 'claude' });
  const session = await cli('land', 'stop', 'w/A1');
  assert.equal(session.code, 1);
  assert.match(session.err, /^A1's land runs in a session the board didn't launch/);

  write(recordFile(), { started: now(), kind: 'claude', session: { pid: run.root, at: now() } });
  const r = await cli('land', 'stop', 'w/A1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: land stopped by orchestrator\n/);
  await until(() => ![run.root, run.land, run.suite].some(alive), 'the builder, its land and its suite are gone');
  assert.equal(read(recordFile()).stopped.run, 'land');
});

test('a bump orders the land queue: a bumped land goes ahead of the ones asked before it, a later bump first, and a running land is never stopped', async (t) => {
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = old; });
  const order = [];
  const hold = holdingLandLock('#1', () => sleep(400).then(() => order.push('#1')));
  await sleep(50);
  const queued = [];
  for (const [card, first] of [['#2', null], ['#3', '2026-11-05T10:00:00.000Z'], ['#4', null], ['#5', '2026-11-05T11:00:00.000Z']]) {
    queued.push(holdingLandLock(card, async () => { order.push(card); }, { site: '/s', key: `w/${card.slice(1)}`, first }));
    await sleep(20);
  }
  await until(() => landQueue().length === 5, 'every land is queued');
  assert.deepEqual(landQueue().map((q) => [q.card, q.running, Boolean(q.first)]), [['#1', true, false], ['#5', false, true], ['#3', false, true], ['#2', false, false], ['#4', false, false]]);
  // The orchestrator's bump of a land already waiting moves it first; #1 keeps running.
  assert.equal(moveQueuedLand('/s', 'w/4', '2026-11-05T12:00:00.000Z'), 1);
  assert.equal(moveQueuedLand('/s', 'w/9', '2026-11-05T12:00:00.000Z'), 0);
  await Promise.all([hold, ...queued]);
  assert.deepEqual(order, ['#1', '#4', '#5', '#3', '#2']);
});

test('item bump moves a queued land first with a thread line, item unbump puts it back in ask order, and land queue lists the queue', async (t) => {
  write(kick('land.queue', `${'1'.padStart(15, '0')}-000000-${process.pid}`), { card: 'B9', site: '/other', key: 'w/B9', first: null });
  write(kick('land.queue', `${'2'.padStart(15, '0')}-000001-${process.pid}`), { card: 'A1', site: site('orch'), key: 'w/A1', first: null });
  write(kick('land.lock'), { card: 'C3', pid: process.pid, at: now() });
  const before = await cli('land', 'queue');
  assert.equal(before.code, 0, before.err);
  assert.equal(before.out, 'C3 landing now\n1. B9\n2. A1\n');
  const bumped = await cli('item', 'bump', 'w/A1');
  assert.equal(bumped.code, 0, bumped.err);
  assert.equal(bumped.out, 'A1 bumped: its land moved first\n');
  assert.deepEqual(lines(site('orch', 'data', 'events.jsonl')).slice(-1).map((e) => [e.kind, e.data.key]), [['card-bump', 'w/A1']]);
  assert.deepEqual(thread().map((l) => l.text), ['land moved first by orchestrator']);
  assert.equal((await cli('land', 'queue')).out, 'C3 landing now\n1. A1 (bumped)\n2. B9\n');
  const unbumped = await cli('item', 'unbump', 'w/A1');
  assert.equal(unbumped.code, 0, unbumped.err);
  assert.equal(unbumped.out, 'A1 unbumped\n');
  assert.equal((await cli('land', 'queue')).out, 'C3 landing now\n1. B9\n2. A1\n');
  fs.rmSync(kick('land.lock'));
  fs.rmSync(kick('land.queue'), { recursive: true });
  assert.equal(board('--site', 'orch', 'land', 'queue').out, 'no land queued\n');
  // A bump with no land queued is the board's bump alone.
  assert.equal(board('--site', 'orch', 'item', 'bump', 'w/A1').out, 'A1 bumped\n');
});

test('one function words every stop, and a stopped build reads it as its status, waiting on the orchestrator from the stop', () => {
  assert.equal(stoppedWords('land'), 'land stopped by orchestrator');
  assert.equal(stoppedWords('build'), 'build stopped by orchestrator');
  const started = '2026-11-05T10:00:00.000Z';
  const stop = '2026-11-05T10:20:00.000Z';
  const card = (record, alive = { 'w/A1': true }) => buildBoard({
    fromWaves: true, now: Date.parse('2026-11-05T10:21:00.000Z'), alive,
    files: [{ slug: 'w', agents: { A1: { main: record } }, itemFile: { items: [{ id: 'A1', title: 'One', lane: 'progress' }] } }],
  }).items[0];
  const stopped = card({ kind: 'claude', started, stopped: { run: 'build', at: stop } });
  assert.deepEqual([stopped.lane, stopped.builder.stopped, stopped.builder.alive, stopped.builder.stale, stopped.builder.silentSince], ['progress', 'build stopped by orchestrator', false, true, stop]);
  assert.deepEqual([stopped.orchestrator.kind, stopped.orchestrator.since], ['stale', stop]);
  // A build started again after the stop reads as it runs.
  const restarted = card({ kind: 'claude', started: '2026-11-05T10:20:30.000Z', stopped: { run: 'build', at: stop } });
  assert.deepEqual([restarted.builder.stopped, restarted.builder.alive], [null, true]);
});

test("a held card's stopped land reads land stopped by orchestrator in In Review until the next Merge tap", () => {
  const card = (merge_ready) => buildBoard({
    fromWaves: true, branch: 'main',
    files: [{ slug: 'w', agents: {}, itemFile: { items: [{ id: 'A1', title: 'One', branch: 'A1', merge_ready }] } }],
    threads: { 'w/A1': [{ ts: '2026-11-05T11:01:00.000Z', who: 'claude', text: 'land stopped by orchestrator' }] },
  }).items[0];
  const stopped = card({ branch: 'A1', at: '2026-11-05T10:00:00.000Z', tapped: '2026-11-05T11:00:00.000Z', stopped: '2026-11-05T11:01:00.000Z' });
  assert.deepEqual([stopped.lane, stopped.merging, stopped.action?.kind], ['review', false, 'merge']);
  assert.deepEqual(stopped.landStopped, { words: 'land stopped by orchestrator', at: '2026-11-05T11:01:00.000Z' });
  assert.equal(card({ branch: 'A1', at: '2026-11-05T10:00:00.000Z', tapped: '2026-11-05T11:02:00.000Z', stopped: '2026-11-05T11:01:00.000Z' }).landStopped, null);
});

test('the server never relaunches a build the orchestrator stopped: it stays tracked, handed back', async () => {
  const launch = async () => assert.fail('a stopped build is not relaunched');
  const handBack = async () => assert.fail('a stop writes its own thread line');
  const tracked = { 'w/A': { model: 'opus', pid: 7, relaunched: false } };
  const next = await reviveBuilders(tracked, new Set(['w/A']), { launch, handBack, alive: () => false, stopped: new Set(['w/A']) });
  assert.deepEqual(next, { 'w/A': { ...tracked['w/A'], handedBack: true } });
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test("item stall stops the card's run with everything under it, keeps its record open and stopped, flags the card with the reason and says so in its thread", async (t) => {
  const run = await fakeRun(t, { nested: true });
  setA1({ lane: 'progress' });
  write(recordFile(), { started: new Date(Date.now() - 60_000).toISOString(), kind: 'claude', session: { id: 's1', pid: run.root, at: now() }, worktree: { path: '/w/A1' } });
  const r = await cli('item', 'stall', 'w/A1', '--reason', 'Crashed twice on the same test');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1 stalled: Crashed twice on the same test\n/);
  assert.match(r.out, new RegExp(`stopped ${run.root} `));
  await until(() => ![run.root, run.land, run.suite].some(alive), 'the builder and its suite are gone');
  const record = read(recordFile());
  assert.deepEqual([record.stopped.run, record.done, record.worktree.path], ['build', undefined, '/w/A1']);
  const item = read(waveFile()).items.find((i) => i.id === 'A1');
  assert.deepEqual([item.lane, item.stalled.reason, typeof item.stalled.at], ['progress', 'Crashed twice on the same test', 'string']);
  assert.deepEqual(thread().map((l) => [l.who, l.text]), [['claude', 'stalled by orchestrator: Crashed twice on the same test']]);

  // A run already gone has nothing to stop; the card is flagged all the same.
  setA1({ stalled: undefined });
  write(recordFile(), { started: now(), kind: 'claude' });
  const gone = await cli('item', 'stall', 'w/A1', '--reason', 'Gone twice');
  assert.equal(gone.code, 0, gone.err);
  assert.equal(gone.out, 'A1 stalled: Gone twice\n');
  assert.equal(read(recordFile()).stopped.run, 'build');
  assert.equal(read(waveFile()).items.find((i) => i.id === 'A1').stalled.reason, 'Gone twice');

  const bare = await cli('item', 'stall', 'w/A1');
  assert.equal(bare.code, 1);
  assert.match(bare.err, /--reason/);
});
