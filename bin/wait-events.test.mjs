import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { until, ownSession, stallingPs, untilTestEnds } from '../shared/test-helpers.mjs';
import { watch as watchInProcess } from './wait-events.mjs';
import { sessionGone as sessionGoneFor } from '../hub/live.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };

// A watcher in this process on a clock the test turns: each step ends one of its sleeps and returns once it reaches the
// next, or exits. It reads the home from HOME, so the test points that at its own for its length, and its session
// never dies unless the test says so.
function inProcess(t, home, { pid, session = 's1', gone = () => false } = {}) {
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  const lines = [];
  let release = null;
  let reached = null;
  let finished = false;
  const sleep = () => new Promise((resolve) => { release = resolve; reached?.(); });
  const done = watchInProcess({ route: 'shop', session, sleep, sessionGone: () => gone(), log: (line) => lines.push(line), pid, links: () => [] }).then((code) => { finished = true; reached?.(); return code; });
  const arrival = () => (release || finished ? Promise.resolve() : new Promise((resolve) => { reached = resolve; }));
  const step = async () => {
    await arrival();
    if (finished) return;
    const wake = release;
    release = null;
    wake();
    await new Promise((resolve) => { reached = resolve; if (release || finished) resolve(); });
  };
  return {
    done,
    out: () => lines.join('\n') + (lines.length ? '\n' : ''),
    finished: () => finished,
    pass: async (n = 1) => { for (let i = 0; i < n; i++) await step(); },
    run: async () => { while (!finished) await step(); return done; },
  };
}

test('paused watchers hold hub work through owner wakes and restarts, and report it after reset', { timeout: 120000 }, async (t) => {
  const home = tempDir('paused-watch-');
  const dir = path.join(home, 'site');
  const state = path.join(home, '.claude', 'kickflip');
  const events = path.join(dir, 'data', 'events.jsonl');
  const cursor = path.join(dir, 'data', '.watch-cursor-s1.json');
  const reset = new Date(Date.now() + 3600_000).toISOString();
  const usage = (resets_at) => ({ claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at } } });
  write(path.join(state, 'manifest.json'), { sites: { shop: { dir, watch: ['data/events.jsonl'], owner: { session: 's1' } } } });
  write(path.join(dir, 'board.json'), { title: 'Shop', rules: [{ id: 'b1', text: 'Board rule' }] });
  write(path.join(state, 'settings.json'), { rules: [{ id: 'h1', text: 'Hub rule' }] });
  write(path.join(state, 'usage.json'), usage(reset));
  write(path.join(dir, 'data', 'orchestrator-waits.json'), { waits: [
    { key: 'w/A1', ref: 'A1', title: 'One', kind: 'calls', since: '2026-11-04T10:00:00.000Z', picked: null, next: "Verify the builder's judgment calls" },
    { key: 'w/A2', ref: 'A2', title: 'Two', kind: 'answer', since: '2026-11-04T10:05:00.000Z', picked: '2026-11-04T10:06:00.000Z', next: "Act on the owner's answer", bumpedAt: '2026-11-04T09:00:00.000Z' },
  ] });
  write(cursor, { 'data/events.jsonl': 0 });
  write(events, '');
  const add = (kind, data) => fs.appendFileSync(events, JSON.stringify({ id: kind, kind, ts: new Date().toISOString(), data }) + '\n');
  for (const kind of ['github-change', 'check-github', 'card-unblocked']) add(kind);
  add('check-github', { reason: 'morning' });
  const first = inProcess(t, home, { pid: 900001 });
  await first.pass();
  assert.equal(first.finished(), false);
  assert.equal(first.out(), '');
  add('item-message', { key: 'w/A1' });
  add('item-message', { key: 'w/A1', text: 'Use the blue', intent: 'build' });
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md: a re-wake wakes a paused session too.
  add('orchestrator-waits', { added: ['w/A3'], again: [{ key: 'w/A1', ref: 'A1', kind: 'calls', since: new Date(Date.now() - 2 * 3600_000 - 30_000).toISOString(), next: "Verify the builder's judgment calls" }] });
  add('builder-ask', { key: 'w/A1', ask: 'ask1', agent: 'main', text: 'Stay orange?' });
  assert.equal(await first.run(), 0);
  const out = { stdout: first.out() };
  assert.match(out.stdout, /^event data\/events.jsonl .*"kind":"item-message".*\nmessage received from A1's thread: reply in its thread; ask open points with reply --questions <json>, not in prose$/m);
  // docs/adr/2026-11-07-0700-staging-then-ready.md
  assert.match(out.stdout, /^event data\/events.jsonl .*"intent":"build".*\nImplement asked on A1: it is staging, the message in its notes; judge it against the whole board, then item set --phase ready --text "<what you checked>", or --phase grilling or prototyping$/m);
  // A builder's ask wakes the session while usage is paused: the builder is mid-build.
  assert.match(out.stdout, /^event data\/events.jsonl .*"kind":"builder-ask".*\nask1 from A1's builder: Stay orange\? \(builder answer it, or builder defer it\)$/m);
  assert.match(out.stdout, /^event data\/events.jsonl .*"kind":"orchestrator-waits".*\nwaiting on you now: w\/A3 · still waiting on you: A1 calls for 2h: Verify the builder's judgment calls$/m);
  assert.doesNotMatch(out.stdout, /"kind":"github-change"|"kind":"check-github"|"kind":"card-unblocked"/);
  // Every wake walks the cards idle on the orchestrator, lanes top-down, after the events and before the rules.
  assert.match(out.stdout, /Stay orange\? \(builder answer it, or builder defer it\)\nwaits calls A1 w\/A1 since 2026-11-04T10:00:00.000Z: Verify the builder's judgment calls\nwaits answer A2 w\/A2 bumped since 2026-11-04T10:05:00.000Z, picked up 2026-11-04T10:06:00.000Z: Act on the owner's answer\nrule hub /);
  assert.match(out.stdout, new RegExp(`rule hub Hub rule[^]*rule board Board rule[^]*setting auto-merge off[^]*\\nquiet [^\\n]*AskUserQuestion[^]*usage paused ${reset} five_hour 91%`));
  const saved = JSON.parse(fs.readFileSync(cursor, 'utf8'));
  assert.equal(saved['data/events.jsonl'], 8);
  assert.equal(saved.$usageHeld['data/events.jsonl'].length, 4);
  const second = inProcess(t, home, { pid: 900002 });
  await second.pass();
  assert.equal(second.finished(), false);
  write(path.join(state, 'usage.json'), usage(new Date(Date.now() - 1000).toISOString()));
  assert.equal(await second.run(), 0);
  const resumed = { stdout: second.out() };
  for (const kind of ['github-change', 'check-github', 'card-unblocked']) assert.ok(resumed.stdout.includes(`"kind":"${kind}"`));
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
  assert.match(resumed.stdout, /"reason":"morning".*\nthe daily wake: run one GitHub tick, then walk every lane top-down once: clear each blocked-until condition that holds, and act on any task stuck with no wait; a thread line on each task you act on, nothing else$/m);
  assert.doesNotMatch(resumed.stdout, /item-message|usage paused/);
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8')).$usageHeld, undefined);
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test("a board's own pause holds its hub work as a usage pause does and names itself, until it is lifted", { timeout: 60000 }, async (t) => {
  const home = tempDir('board-pause-watch-');
  const dir = path.join(home, 'site');
  const state = path.join(home, '.claude', 'kickflip');
  const events = path.join(dir, 'data', 'events.jsonl');
  const until = new Date(Date.now() + 3600_000).toISOString();
  write(path.join(state, 'manifest.json'), { sites: { shop: { dir, watch: ['data/events.jsonl'], owner: { session: 's1' } } } });
  write(path.join(dir, 'board.json'), { title: 'Shop', paused_until: until });
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 0 });
  write(events, JSON.stringify({ id: 'g', kind: 'github-change', ts: new Date().toISOString() }) + '\n');
  const first = inProcess(t, home, { pid: 900001 });
  await first.pass(2);
  assert.equal(first.finished(), false, 'the held github-change wakes nothing');
  fs.appendFileSync(events, JSON.stringify({ id: 'm', kind: 'item-message', ts: new Date().toISOString(), data: { key: 'w/A1' } }) + '\n');
  assert.equal(await first.run(), 0);
  const out = first.out();
  assert.match(out, /"kind":"item-message"/);
  assert.doesNotMatch(out, /"kind":"github-change"/);
  assert.match(out, new RegExp(`\\nusage paused ${until} manual board\\n`));
  const second = inProcess(t, home, { pid: 900002 });
  await second.pass(2);
  assert.equal(second.finished(), false);
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  assert.equal(await second.run(), 0);
  const resumed = second.out();
  assert.match(resumed, /"kind":"github-change"/);
  assert.doesNotMatch(resumed, /usage paused/);
});

const WATCHER = new URL('./wait-events.mjs', import.meta.url).pathname;
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A home with one board `shop` owned by session s1, its events file and cursor at 0.
function shop(t) {
  const home = tempDir('orphan-watch-');
  const dir = path.join(home, 'site');
  const pids = [];
  t.after(() => { for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL'); });
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: { shop: { dir, watch: ['data/events.jsonl'], owner: { session: 's1' } } } });
  write(path.join(dir, 'data', 'events.jsonl'), '');
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 0 });
  const add = (kind) => fs.appendFileSync(path.join(dir, 'data', 'events.jsonl'), JSON.stringify({ id: kind, kind, ts: new Date().toISOString() }) + '\n');
  const watcherRecord = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'watcher.json'), 'utf8')); } catch { return null; } };
  const env = { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' };
  // A process whose command line reads like a watcher's, which only sleeps.
  const lookalike = (...args) => {
    const c = spawn(process.execPath, ['-e', untilTestEnds(), 'wait-events.mjs', ...args], { stdio: 'ignore' });
    pids.push(c.pid);
    return c;
  };
  const watch = () => {
    const child = spawn(process.execPath, [WATCHER, 'shop', 's1'], { env });
    pids.push(child.pid);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout })));
    return { child, done };
  };
  return { home, dir, pids, env, add, watcherRecord, lookalike, watch };
}

test("a watcher whose session dies exits without taking the next event, so the resumed session's watcher gets it", async (t) => {
  const { home, dir, add, watcherRecord } = shop(t);
  let died = false;
  // The shell's parent and the session as the watcher saw them at start; the session dying changes the parent.
  const gone = () => sessionGoneFor('s1', [100, 200], { ppid: 100, parent: () => (died ? 1 : 200), live: () => new Set(['s1']) });
  const orphan = inProcess(t, home, { pid: 900001, gone });
  await orphan.pass(2);
  assert.equal(orphan.finished(), false, 'the watcher waits while its session runs');
  assert.ok(watcherRecord().checks >= 1);
  died = true;
  add('ask');
  assert.equal(await orphan.run(), 0);
  assert.equal(orphan.out(), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', '.watch-cursor-s1.json'), 'utf8')), { 'data/events.jsonl': 0 });
  assert.ok(watcherRecord().exited_at, 'the board reads the watcher as exited');
  const resumed = inProcess(t, home, { pid: 900002 });
  assert.equal(await resumed.run(), 0);
  assert.match(resumed.out(), /^event data\/events.jsonl .*"kind":"ask"/);
});

test("a watcher keeps waiting while ps can't answer whether its session runs, and takes the next event", async (t) => {
  const { home, add } = shop(t);
  // ps gives no answer for the parent (undefined) or the live sessions (null) until the test lets it.
  let answering = false;
  const gone = () => sessionGoneFor('s1', [100, 200], { ppid: 100, parent: () => (answering ? 200 : undefined), live: () => (answering ? new Set(['s1']) : null) });
  const w = inProcess(t, home, { pid: 900001, gone });
  await w.pass(4);
  assert.equal(w.finished(), false, 'the watcher still waits');
  assert.equal(w.out(), '');
  answering = true;
  add('ask');
  assert.equal(await w.run(), 0);
  assert.match(w.out(), /^event data\/events.jsonl .*"kind":"ask"/);
});

test('a new watcher for the same session stops the one watcher.json records, and no other process', async (t) => {
  const { home, add, watcherRecord, lookalike, watch } = shop(t);
  ownSession(home, 's1');
  const record = (pid, extra = {}) => write(path.join(home, 'site', 'data', 'watcher.json'), { pid, since: new Date().toISOString(), ...extra });
  const other = lookalike('shop', 's2');
  record(other.pid);
  const first = watch();
  await until(() => watcherRecord()?.pid === first.child.pid, 'the first watcher started');
  // The next watchers run in this process: only the first, a real process, has something to stop.
  const second = inProcess(t, home, { pid: 900002 });
  const stopped = await first.done;
  assert.equal(stopped.signal, 'SIGTERM');
  assert.equal(stopped.stdout, '');
  await second.pass();
  assert.equal(watcherRecord().pid, 900002);
  assert.equal(watcherRecord().exited_at, undefined);
  add('ask');
  assert.equal(await second.run(), 0);
  assert.equal(typeof watcherRecord().exited_at, 'string');
  // A watcher that exited on an event recorded exited_at; its pid, even if something like it runs there now, is left alone.
  const exited = lookalike('shop', 's1');
  record(exited.pid, { exited_at: new Date().toISOString() });
  const third = inProcess(t, home, { pid: 900003 });
  await third.pass();
  assert.equal(watcherRecord().pid, 900003);
  assert.ok(running(other.pid) && running(exited.pid), "another session's watcher and an exited watcher's pid are left alone");
  add('ask');
  assert.equal(await third.run(), 0);
  assert.match(third.out(), /^event data\/events.jsonl .*"kind":"ask"/);
});

test('a watcher stopped by SIGTERM leaves its exit time in watcher.json, and ends by the signal', async (t) => {
  const { home, watcherRecord, watch } = shop(t);
  ownSession(home, 's1');
  const w = watch();
  await until(() => Number.isInteger(watcherRecord()?.pid) && watcherRecord().checks >= 1, 'the watcher checked once');
  w.child.kill('SIGTERM');
  assert.equal((await w.done).signal, 'SIGTERM');
  assert.equal(typeof watcherRecord().exited_at, 'string');
  assert.equal(watcherRecord().pid, w.child.pid);
});

test('record-only events and pings do not wake the session: a ping is acked at once, and the held lines print on the next wake ahead of the new events', async (t) => {
  const { home, dir } = shop(t);
  const events = path.join(dir, 'data', 'events.jsonl');
  const cursor = path.join(dir, 'data', '.watch-cursor-s1.json');
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  const w = inProcess(t, home, { pid: 900001 });
  const line = (id, kind, data) => fs.appendFileSync(events, JSON.stringify({ id, kind, ts: new Date().toISOString(), data }) + '\n');
  for (const kind of ['main-pulled', 'settings', 'reviewers-removed', 'reviewers-added', 'repo-changed']) line(kind, kind, {});
  line('p1', 'ping', { title: 'Shop' });
  await w.pass();
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8'))['data/events.jsonl'], 6, 'held lines moved the cursor');
  assert.equal(w.finished(), false);
  assert.equal(w.out(), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'handshake.json'), 'utf8')).ack.id, 'p1');
  // docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md: a button tap changes the card or starts
  // an agent in the board server, so it wakes nobody; text typed with Grill, Prototype or Visual goes to that agent.
  line('b1', 'card-hold', { key: 'w/A1', hold: true });
  line('b2', 'card-hold', { key: 'w/A1', hold: false });
  line('b3', 'card-done', { key: 'w/A3' });
  line('b4', 'card-unbump', { key: 'w/A1' });
  line('b5', 'card-unblocked', { key: 'w/A4' });
  line('b6', 'grill-more', { key: 'w/A1', text: 'Ask about the footer' });
  line('b7', 'prototype-request', { key: 'w/A1' });
  line('b8', 'visual-request', { key: 'w/A1', text: 'Draw it' });
  await w.pass();
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8'))['data/events.jsonl'], 14, 'tap lines moved the cursor');
  assert.equal(w.finished(), false);
  assert.equal(w.out(), '');
  line('w1', 'item-message', { key: 'w/A1', text: 'Wake' });
  assert.equal(await w.run(), 0);
  const lines = w.out().split('\n');
  const at = (kind) => lines.findIndex((l) => l.includes(`"kind":"${kind}"`));
  assert.ok(at('main-pulled') >= 0 && at('main-pulled') < at('settings') && at('settings') < at('reviewers-removed') && at('reviewers-removed') < at('reviewers-added') && at('reviewers-added') < at('repo-changed') && at('repo-changed') < at('ping') && at('ping') < at('card-hold'));
  assert.ok(lines.includes('ping p1 from the hub answered'));
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8')).$quietHeld, undefined);
  // Only the event that woke the session reads Working on it.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'working.json'), 'utf8')).events), ['w1']);
  // docs/adr/2026-11-15-1700-a-card-reads-thinking-from-its-events-delivery-until-the-orchestrator-writes.md: the event
  // that woke the session is stamped delivered at the wake, the board's first stamp; the record-only lines aren't.
  const delivered = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'delivered.json'), 'utf8'));
  assert.deepEqual(delivered.events, { w1: delivered.since });
  assert.ok(lines.findIndex((l) => l.includes('"id":"b8"')) < lines.findIndex((l) => l.includes('"id":"w1"')), 'the taps print ahead of the message');
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test('on a board a new task wakes the session with its sort line and reads Working on it', async (t) => {
  const { home, dir } = shop(t);
  const events = path.join(dir, 'data', 'events.jsonl');
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  const w = inProcess(t, home, { pid: 900001 });
  await w.pass();
  fs.appendFileSync(events, JSON.stringify({ id: 'a1', kind: 'ask', ts: new Date().toISOString(), data: { text: 'New task' } }) + '\n');
  assert.equal(await w.run(), 0);
  const stdout = w.out();
  assert.ok(stdout.split('\n').includes('new task a1 received as task a1: triage it first, from what you know of the board, reading no code: item triage <its key> --title --phase discussing|grilling|prototyping|visual with its links and --text, or --fold-into <task> for a duplicate; then investigate'), stdout);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'working.json'), 'utf8')).events), ['a1']);
});

// docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md
test('a wake prints a message the PostToolUse hook already showed again, its plain line tagged already shown', async (t) => {
  const { home, dir, add } = shop(t);
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  fs.appendFileSync(path.join(dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', kind: 'item-message', ts: new Date().toISOString(), data: { key: 'w/A1', text: 'Blue' } }) + '\n');
  add('ask');
  write(path.join(dir, 'data', '.shown-s1.json'), { ids: ['m1'] });
  const w = inProcess(t, home, { pid: 900001 });
  assert.equal(await w.run(), 0);
  const stdout = w.out();
  assert.match(stdout, /^event data\/events.jsonl .*"kind":"item-message".*\nalready shown: message received from A1's thread: reply in its thread; ask open points with reply --questions <json>, not in prose$/m);
  assert.match(stdout, /^event data\/events.jsonl .*"kind":"ask".*\nnew task ask received/m);
});

// docs/adr/2026-11-12-1300-sorting-an-ask-refuses-an-edit-the-orchestrator-hasnt-read.md
test('a wake that prints an ask edit moves the ask\'s working mark to now, so sorting it goes through', async (t) => {
  const { home, dir } = shop(t);
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  write(path.join(dir, 'data', 'working.json'), { events: { a1: '2026-11-12T09:38:03.000Z', m0: '2026-11-12T09:00:00.000Z' } });
  fs.appendFileSync(path.join(dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'x1', kind: 'ask-edited', ts: new Date().toISOString(), data: { id: 'a1', text: 'Edited' } }) + '\n');
  const before = Date.now();
  assert.equal(await inProcess(t, home, { pid: 900001 }).run(), 0);
  const marks = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'working.json'), 'utf8')).events;
  assert.ok(Date.parse(marks.a1) >= before, marks.a1);
  assert.deepEqual([marks.m0, marks.x1], ['2026-11-12T09:00:00.000Z', undefined]);
});
