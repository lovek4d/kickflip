import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { until, ownSession, stallingPs, untilTestEnds } from '../shared/test-helpers.mjs';

const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };

test('paused watchers hold hub work through owner wakes and restarts, and report it after reset', { timeout: 120000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paused-watch-'));
  const dir = path.join(home, 'site');
  const state = path.join(home, '.claude', 'kickflip');
  const events = path.join(dir, 'data', 'events.jsonl');
  const cursor = path.join(dir, 'data', '.watch-cursor-s1.json');
  const watcher = path.join(dir, 'data', 'watcher.json');
  const reset = new Date(Date.now() + 3600_000).toISOString();
  const usage = (resets_at) => ({ claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at } } });
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  write(path.join(state, 'manifest.json'), { sites: { shop: { dir, watch: ['data/events.jsonl'], owner: { session: 's1' } } } });
  write(path.join(dir, 'board.json'), { title: 'Shop', rules: [{ id: 'b1', text: 'Board rule' }] });
  write(path.join(state, 'settings.json'), { rules: [{ id: 'h1', text: 'Hub rule' }] });
  write(path.join(state, 'usage.json'), usage(reset));
  write(path.join(dir, 'data', 'orchestrator-waits.json'), { waits: [
    { key: 'w/A1', ref: 'A1', title: 'One', kind: 'calls', since: '2026-11-04T10:00:00.000Z', picked: null, next: "Verify the builder's judgment calls" },
    { key: 'w/A2', ref: 'A2', title: 'Two', kind: 'answer', since: '2026-11-04T10:05:00.000Z', picked: '2026-11-04T10:06:00.000Z', next: "Act on the owner's answer", bumpedAt: '2026-11-04T09:00:00.000Z' },
  ] });
  ownSession(home, 's1');
  write(cursor, { 'data/events.jsonl': 0 });
  write(events, '');
  const add = (kind, data) => fs.appendFileSync(events, JSON.stringify({ id: kind, kind, ts: new Date().toISOString(), data }) + '\n');
  for (const kind of ['github-change', 'check-github', 'card-unblocked']) add(kind);
  add('check-github', { reason: 'morning' });
  const start = () => {
    const child = spawn(process.execPath, [new URL('./wait-events.mjs', import.meta.url).pathname, 'shop', 's1'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' } });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr })); });
    return { child, done, stdout: () => stdout };
  };
  const first = start();
  await until(() => fs.existsSync(watcher), 'watcher started');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(first.child.exitCode, null);
  assert.equal(first.stdout(), '');
  add('item-message', { key: 'w/A1' });
  add('item-message', { key: 'w/A1', text: 'Use the blue', intent: 'build' });
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md: a re-wake wakes a paused session too.
  add('orchestrator-waits', { added: ['w/A3'], again: [{ key: 'w/A1', ref: 'A1', kind: 'calls', since: new Date(Date.now() - 2 * 3600_000 - 30_000).toISOString(), next: "Verify the builder's judgment calls" }] });
  add('builder-ask', { key: 'w/A1', ask: 'ask1', agent: 'main', text: 'Stay orange?' });
  const out = await first.done;
  assert.deepEqual([out.code, out.stderr], [0, '']);
  assert.match(out.stdout, /^event data\/events.jsonl .*"kind":"item-message".*\nmessage received from A1's thread: reply in its thread$/m);
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
  const second = start();
  // The watcher writes its file in place, so a read can land between the truncate and the write.
  const watcherPid = () => { try { return JSON.parse(fs.readFileSync(watcher, 'utf8')).pid; } catch { return null; } };
  await until(() => watcherPid() === second.child.pid, 'replacement watcher started');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(second.child.exitCode, null);
  write(path.join(state, 'usage.json'), usage(new Date(Date.now() - 1000).toISOString()));
  const resumed = await second.done;
  assert.deepEqual([resumed.code, resumed.stderr], [0, '']);
  for (const kind of ['github-change', 'check-github', 'card-unblocked']) assert.ok(resumed.stdout.includes(`"kind":"${kind}"`));
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
  assert.match(resumed.stdout, /"reason":"morning".*\nthe daily wake: run one GitHub tick, then walk every lane top-down once: clear each blocked-until condition that holds, and act on any card stuck with no wait; a thread line on each card you act on, nothing else$/m);
  assert.doesNotMatch(resumed.stdout, /item-message|usage paused/);
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8')).$usageHeld, undefined);
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test("a board's own pause holds its hub work as a usage pause does and names itself, until it is lifted", { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-pause-watch-'));
  const dir = path.join(home, 'site');
  const state = path.join(home, '.claude', 'kickflip');
  const events = path.join(dir, 'data', 'events.jsonl');
  const until = new Date(Date.now() + 3600_000).toISOString();
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  write(path.join(state, 'manifest.json'), { sites: { shop: { dir, watch: ['data/events.jsonl'], owner: { session: 's1' } } } });
  write(path.join(dir, 'board.json'), { title: 'Shop', paused_until: until });
  ownSession(home, 's1');
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 0 });
  write(events, JSON.stringify({ id: 'g', kind: 'github-change', ts: new Date().toISOString() }) + '\n');
  const start = () => {
    const child = spawn(process.execPath, [WATCHER, 'shop', 's1'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' } });
    children.push(child);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    return { child, done: new Promise((resolve) => child.on('close', () => resolve(stdout))) };
  };
  const first = start();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(first.child.exitCode, null, 'the held github-change wakes nothing');
  fs.appendFileSync(events, JSON.stringify({ id: 'm', kind: 'item-message', ts: new Date().toISOString(), data: { key: 'w/A1' } }) + '\n');
  const out = await first.done;
  assert.match(out, /"kind":"item-message"/);
  assert.doesNotMatch(out, /"kind":"github-change"/);
  assert.match(out, new RegExp(`\\nusage paused ${until} manual board\\n`));
  const second = start();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(second.child.exitCode, null);
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  const resumed = await second.done;
  assert.match(resumed, /"kind":"github-change"/);
  assert.doesNotMatch(resumed, /usage paused/);
});

const WATCHER = new URL('./wait-events.mjs', import.meta.url).pathname;
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A home with one board `shop` owned by session s1, its events file and cursor at 0.
function shop(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-watch-'));
  const dir = path.join(home, 'site');
  const pids = [];
  t.after(() => { for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
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

test("a watcher whose session dies exits without taking the next event, so the resumed session's watcher gets it", { timeout: 60000 }, async (t) => {
  const { home, dir, pids, env, add, watcherRecord, watch } = shop(t);
  // A stand-in Claude session runs a stand-in shell, which runs the watcher, as Claude Code runs a background task.
  const out = path.join(home, 'watcher.out');
  const shell = `const c = require('node:child_process').spawn(process.execPath, ${JSON.stringify([WATCHER, 'shop', 's1'])}, { stdio: ['ignore', require('node:fs').openSync(${JSON.stringify(out)}, 'w'), 'inherit'] }); ${untilTestEnds()};`;
  const claude = spawn(process.execPath, ['-e', `const s = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(shell)}], { stdio: 'ignore' }); process.send(s.pid); ${untilTestEnds()};`], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  pids.push(claude.pid);
  pids.push(await new Promise((resolve) => claude.once('message', resolve)));
  ownSession(home, 's1', claude.pid);
  await until(() => Number.isInteger(watcherRecord()?.pid), 'the watcher started');
  const orphan = watcherRecord().pid;
  pids.push(orphan);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.ok(running(orphan), 'the watcher waits while its session runs');
  const died = new Promise((resolve) => claude.once('exit', resolve));
  claude.kill('SIGKILL');
  await died;
  add('ask');
  await until(() => !running(orphan), 'the orphaned watcher exits');
  assert.equal(fs.readFileSync(out, 'utf8'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', '.watch-cursor-s1.json'), 'utf8')), { 'data/events.jsonl': 0 });
  assert.ok(watcherRecord().exited_at, 'the board reads the watcher as exited');
  ownSession(home, 's1');
  const resumed = await watch().done;
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, /^event data\/events.jsonl .*"kind":"ask"/);
});

test("a watcher keeps waiting while ps can't answer whether its session runs, and takes the next event", { timeout: 90000 }, async (t) => {
  const { home, env, add, watcherRecord } = shop(t);
  ownSession(home, 's1');
  const ps = stallingPs(home);
  t.after(() => ps.stall(false));
  const child = spawn(process.execPath, [WATCHER, 'shop', 's1'], { env: { ...env, PATH: `${ps.bin}:${env.PATH}`, KICKFLIP_PS_TIMEOUT_MS: '200' } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await until(() => watcherRecord()?.pid === child.pid, 'the watcher started');
  ps.stall(true);
  // Each check waits out ps's timeout twice, for the shell's parent and for the session; this waits out two checks.
  await until(() => ps.stalls() >= 4, 'two checks found ps stalled');
  assert.equal(child.exitCode, null, 'the watcher still waits');
  assert.equal(stdout, '');
  ps.stall(false);
  add('ask');
  assert.equal(await done, 0);
  assert.match(stdout, /^event data\/events.jsonl .*"kind":"ask"/);
});

test('a new watcher for the same session stops the one watcher.json records, and no other process', { timeout: 60000 }, async (t) => {
  const { home, add, watcherRecord, lookalike, watch } = shop(t);
  ownSession(home, 's1');
  const record = (pid, extra = {}) => write(path.join(home, 'site', 'data', 'watcher.json'), { pid, since: new Date().toISOString(), ...extra });
  const other = lookalike('shop', 's2');
  record(other.pid);
  const first = watch();
  await until(() => watcherRecord()?.pid === first.child.pid, 'the first watcher started');
  const second = watch();
  const stopped = await first.done;
  assert.equal(stopped.signal, 'SIGTERM');
  assert.equal(stopped.stdout, '');
  await until(() => watcherRecord()?.pid === second.child.pid, 'the second watcher records itself');
  assert.equal(watcherRecord().exited_at, undefined);
  second.child.kill();
  await second.done;
  // A watcher that exited on an event recorded exited_at; its pid, even if something like it runs there now, is left alone.
  const exited = lookalike('shop', 's1');
  record(exited.pid, { exited_at: new Date().toISOString() });
  const third = watch();
  await until(() => watcherRecord()?.pid === third.child.pid, 'the third watcher started');
  assert.ok(running(other.pid) && running(exited.pid), "another session's watcher and an exited watcher's pid are left alone");
  add('ask');
  const woke = await third.done;
  assert.match(woke.stdout, /^event data\/events.jsonl .*"kind":"ask"/);
});

test('record-only events and pings do not wake the session: a ping is acked at once, and the held lines print on the next wake ahead of the new events', { timeout: 60000 }, async (t) => {
  const { home, dir, add } = shop(t);
  const events = path.join(dir, 'data', 'events.jsonl');
  const cursor = path.join(dir, 'data', '.watch-cursor-s1.json');
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  ownSession(home, 's1');
  const child = spawn(process.execPath, [WATCHER, 'shop', 's1'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await until(() => fs.existsSync(path.join(dir, 'data', 'watcher.json')), 'watcher started');
  const line = (id, kind, data) => fs.appendFileSync(events, JSON.stringify({ id, kind, ts: new Date().toISOString(), data }) + '\n');
  for (const kind of ['main-pulled', 'settings', 'reviewers-removed', 'reviewers-added', 'repo-changed']) line(kind, kind, {});
  line('p1', 'ping', { title: 'Shop' });
  await until(() => JSON.parse(fs.readFileSync(cursor, 'utf8'))['data/events.jsonl'] === 6,'held lines moved the cursor');
  assert.equal(child.exitCode, null);
  assert.equal(stdout, '');
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
  await until(() => JSON.parse(fs.readFileSync(cursor, 'utf8'))['data/events.jsonl'] === 14, 'tap lines moved the cursor');
  assert.equal(child.exitCode, null);
  assert.equal(stdout, '');
  line('w1', 'item-message', { key: 'w/A1', text: 'Wake' });
  assert.equal(await exited, 0);
  const lines = stdout.split('\n');
  const at = (kind) => lines.findIndex((l) => l.includes(`"kind":"${kind}"`));
  assert.ok(at('main-pulled') >= 0 && at('main-pulled') < at('settings') && at('settings') < at('reviewers-removed') && at('reviewers-removed') < at('reviewers-added') && at('reviewers-added') < at('repo-changed') && at('repo-changed') < at('ping') && at('ping') < at('card-hold'));
  assert.ok(lines.includes('ping p1 from the hub answered'));
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8')).$quietHeld, undefined);
  // Only the event that woke the session reads Working on it.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'working.json'), 'utf8')).events), ['w1']);
  assert.ok(lines.findIndex((l) => l.includes('"id":"b8"')) < lines.findIndex((l) => l.includes('"id":"w1"')), 'the taps print ahead of the message');
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test('on a board a new task wakes the session with its sort line and reads Working on it', { timeout: 60000 }, async (t) => {
  const { home, dir } = shop(t);
  const events = path.join(dir, 'data', 'events.jsonl');
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  ownSession(home, 's1');
  const child = spawn(process.execPath, [WATCHER, 'shop', 's1'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await until(() => fs.existsSync(path.join(dir, 'data', 'watcher.json')), 'watcher started');
  fs.appendFileSync(events, JSON.stringify({ id: 'a1', kind: 'ask', ts: new Date().toISOString(), data: { text: 'New task' } }) + '\n');
  assert.equal(await exited, 0);
  assert.ok(stdout.split('\n').includes('new task a1 received as task a1: sort that New card: item notes, then item set <its key> --phase grilling or prototyping (ready, with --size, for a Quick build); merge it into a card with item relate-ask a1 <card> --summary; or answer it with reply <its key>'), stdout);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'working.json'), 'utf8')).events), ['a1']);
});

// docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md
test('a wake prints a message the PostToolUse hook already showed again, its plain line tagged already shown', { timeout: 30000 }, async (t) => {
  const { home, dir, add, watch } = shop(t);
  ownSession(home, 's1');
  write(path.join(dir, 'board.json'), { title: 'Shop' });
  fs.appendFileSync(path.join(dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', kind: 'item-message', ts: new Date().toISOString(), data: { key: 'w/A1', text: 'Blue' } }) + '\n');
  add('ask');
  write(path.join(dir, 'data', '.shown-s1.json'), { ids: ['m1'] });
  const { code, stdout } = await watch().done;
  assert.equal(code, 0);
  assert.match(stdout, /^event data\/events.jsonl .*"kind":"item-message".*\nalready shown: message received from A1's thread: reply in its thread$/m);
  assert.match(stdout, /^event data\/events.jsonl .*"kind":"ask".*\nnew task ask received/m);
});
