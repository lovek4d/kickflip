import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { until, startBoard, untilTestEnds } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md
// Each test runs the board server in this process (startBoard) on a clock it sets: Date is frozen at clock.at, since
// the store's functions read their own, and moved with clock.set. The test runs the minute's checks with b.minute(),
// stands for the file watch with b.changed(file), and awaits b.settled() instead of waiting on time.

// Writes a file the running server may be reading the way the board does (write aside, then rename), so the server
// never reads it half-written.
const put = (file, text) => { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); };

// A fresh scratch folder for the test under this file's HOME, with HOME's .claude emptied, the env entries set and the env as it was
// put back when the test ends, and Date frozen at at. → {dir, siteDir, dataDir, clock: {at, set(ms), advance(minutes)}}
function scratch(t, name, at, env = {}) {
  const dir = fs.mkdtempSync(path.join(home, `${name}-`));
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, before); });
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const clock = {
    at,
    set(ms) { clock.at = ms; t.mock.timers.setTime(ms); },
    advance(minutes) { clock.set(clock.at + minutes * 60000); },
  };
  const siteDir = path.join(dir, 'site');
  return { dir, siteDir, dataDir: path.join(siteDir, 'data'), clock };
}

// The server for siteDir, and the way a test restarts it on the same files: stop() closes it, start() runs it again.
// minute() runs the minute's checks and awaits every pass they started; changed(...files) reports each write to the
// server as its watch would and awaits the passes it started.
function server(t, siteDir) {
  const run = { b: null };
  return {
    start: async () => { run.b = await startBoard(t, { site: siteDir }); await run.b.settled(); },
    stop: () => run.b.close(),
    minute: async () => { run.b.minute(); await run.b.settled(); },
    changed: async (...files) => { for (const file of files) run.b.changed(file); await run.b.settled(); },
    settled: () => run.b.settled(),
  };
}

// The board at siteDir as the hub's manifest under HOME records it, building from a git repo of its own, and a fake
// claude that logs the card and kind of each agent the server launches and names its session at once, as claude's init
// event does, so no launch waits out the adapter's wait for a session (board/agents.mjs)
// (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md). → {claude, launched(kinds)}: the cards
// launched with any of kinds, each once, first launch first.
// stays keeps each launched agent running until the test ends, as a planner does until its own done: the board closes the
// record of a planner whose process is gone (docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md),
// so one that ended after a fixed time would free its slot partway through a test on a loaded host.
function launchingBoard(dir, siteDir, { stays = false } = {}) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '--quiet', '-b', 'main');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'base');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { t: { dir: siteDir, port: 1, cmd: ['node', '/x/board/server.mjs'], branch: 'main', owner: { repo } } } }));
  const log = path.join(dir, 'launches.log');
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(claude, `#!/usr/bin/env node\nconst m = process.argv[3].match(/builder start (\\S+) --kind (\\w+)/);\nrequire('fs').appendFileSync(${JSON.stringify(log)}, m[1] + ' ' + m[2] + '\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid }));\n${stays ? `${untilTestEnds()};\n` : ''}`);
  fs.chmodSync(claude, 0o755);
  const launched = (...kinds) => [...new Set((fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, k]) => kinds.includes(k)).map(([key]) => key))];
  return { claude, launched };
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const iso = (ms) => new Date(ms).toISOString();

// docs/adr/2026-11-05-0200-a-stale-review-and-a-silent-builder-join-the-orchestrator-list.md
test('a silent builder wakes the session once per silent spell through the orchestrator list, across a restart, and stops on done', async (t) => {
  const { siteDir, dataDir, clock } = scratch(t, 'builder-stale', Date.parse('2026-10-30T10:00:00Z'), { KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true' });
  const waitsFile = path.join(dataDir, 'orchestrator-waits.json');
  const agentFile = path.join(dataDir, 'agents', 'A1.json');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', lane: 'progress', title: 'One' }] }));
  const started = iso(clock.at - 14 * 60000);
  fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started }));
  const waits = () => JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits;
  const wakes = () => lines(path.join(dataDir, 'events.jsonl')).filter((e) => e.kind === 'orchestrator-waits').map((e) => e.data);
  const board = server(t, siteDir);
  await board.start();
  assert.equal(wakes().length, 0);
  clock.advance(2);
  await board.minute();
  assert.equal(wakes().length, 1, 'the silent builder wakes the session');
  assert.deepEqual(waits().map((w) => [w.key, w.kind, w.since]), [['t/A1', 'stale', started]]);
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(wakes().length, 1, 'once across a restart');

  const progress = iso(clock.at);
  const thread = path.join(dataDir, 'threads', 't__A1.jsonl');
  put(thread, JSON.stringify({ ts: progress, kind: 'status', text: 'Running tests' }) + '\n');
  await board.changed(thread);
  assert.equal(waits().length, 0, 'progress ends the wait');
  // docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md: its clear is logged.
  assert.deepEqual(lines(path.join(dataDir, 'events.jsonl')).filter((e) => e.kind === 'waits-history').at(-1).data,
    { opened: [], cleared: [{ key: 't/A1', ref: 'A1', title: 'One', kind: 'stale', since: started, picked: null, cleared: progress }] });
  clock.advance(31);
  await board.minute();
  assert.equal(wakes().length, 2, 'the next silent spell wakes it again');
  assert.equal(waits()[0].since, progress);

  put(agentFile, JSON.stringify({ kind: 'codex', started, done: iso(clock.at) }));
  await board.changed(agentFile);
  assert.ok(waits().every((w) => w.kind !== 'stale'), 'finishing the builder ends the wait');
  clock.advance(60);
  await board.minute();
  assert.ok(waits().every((w) => w.kind !== 'stale'), 'no silent-builder wait after done');
});

test('a held card resumes itself within a minute of its pick-up time, once per time across a restart, announcing card-unblocked unless a dep is unfinished', async (t) => {
  const { siteDir, dataDir, clock } = scratch(t, 'pick-up', Date.parse('2026-11-04T16:30:00Z'), { KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true' });
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const at = iso(clock.at + 30 * 60000);
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(waveFile, JSON.stringify({ items: [
    { id: 'A0', title: 'Dep', lane: 'progress' },
    { id: 'A1', title: 'Timed', lane: 'todo', held: true, pick_up_at: at, held_at: iso(clock.at - 60000) },
    { id: 'A2', title: 'Blocked', deps: ['A0'], held: true, pick_up_at: at, held_at: iso(clock.at - 60000) },
    { id: 'A3', title: 'Tapped', lane: 'todo' },
    { id: 'A4', title: 'Forever', lane: 'todo', held: true, held_at: iso(clock.at - 60000) },
    { id: 'A5', title: 'Cut short', lane: 'todo', held: true, pick_up_at: at, held_at: iso(clock.at - 60000) },
  ] }));
  fs.writeFileSync(eventsFile, [
    { id: 'e1', ts: iso(clock.at - 30000), kind: 'card-hold', data: { key: 't/A3', hold: true, until: at } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  const items = () => Object.fromEntries(JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.map((it) => [it.id, it]));
  const unblocked = () => lines(eventsFile).filter((e) => e.kind === 'card-unblocked').map((e) => e.data);
  const threadLines = (id) => lines(path.join(dataDir, 'threads', `t__${id}.jsonl`)).length;
  const board = server(t, siteDir);
  await board.start();
  assert.deepEqual(unblocked(), []);
  assert.equal(items().A1.held, true);
  await board.stop();

  fs.appendFileSync(eventsFile, JSON.stringify({ id: 'e2', ts: iso(clock.at), kind: 'card-unblocked', data: { key: 't/A5', until: at } }) + '\n');
  clock.advance(31);
  await board.start();
  assert.ok(!items().A1.held && !items().A2.held && !items().A5.held && items().A3.held_at, 'the due holds resume');
  assert.deepEqual(unblocked().map((d) => [d.key, d.until]).sort(), [['t/A1', at], ['t/A3', at], ['t/A5', at]]);
  // Each had a discussing-start line when the server first moved its phase-less card to discussing.
  assert.deepEqual(['A1', 'A2', 'A3', 'A5'].map(threadLines), [2, 2, 2, 1]);
  assert.deepEqual([items().A1.pick_up_at, items().A4.held], [undefined, true]);
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(unblocked().length, 3);
  assert.deepEqual(['A1', 'A2', 'A3', 'A5'].map(threadLines), [2, 2, 2, 1]);
});

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
test('with auto implement on the board starts and launches the build of the top pullable Todo cards at start and on each change, filling free slots up to Maximum tasks in progress, once each across a restart, and never while paused', async (t) => {
  const { dir, siteDir, dataDir, clock } = scratch(t, 'auto-pull', Date.parse('2026-11-02T16:00:00Z'));
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const pulledFile = path.join(dataDir, 'pulled.json');
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const usageFile = path.join(home, '.claude', 'kickflip', 'usage.json');
  const now = clock.at;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', max_implementers: 2 }));
  const wave = { items: [
    { id: 'A0', title: 'feat: running', lane: 'progress' },
    { id: 'A1', title: 'feat: held', lane: 'todo', phase: 'ready', held: true },
    { id: 'A2', title: 'feat: blocked', phase: 'ready', deps: ['A3'] },
    { id: 'A3', title: 'feat: asking', lane: 'todo', phase: 'ready' },
    { id: 'A4', title: 'feat: next', lane: 'todo', phase: 'ready' },
    { id: 'A5', title: 'feat: bumped', lane: 'todo', phase: 'ready' },
    { id: 'A6', title: 'feat: last', lane: 'todo', phase: 'ready' },
    { id: 'A7', title: 'feat: spare', lane: 'todo', phase: 'ready' },
    { id: 'A8', title: 'An old sentence title', lane: 'todo', phase: 'ready' },
  ], followups: [{ id: 'F1', title: 'Follow-up', from: 'A0', filed: iso(now) }] };
  fs.writeFileSync(waveFile, JSON.stringify(wave));
  fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000) }));
  const question = (id, key) => ({ id, topic: `item:${key}`, question: 'Which?', options: [{ id: 'a', label: 'A' }] });
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [], items: [question('q3', 't/A3')] }));
  fs.writeFileSync(eventsFile, [
    { id: 'e1', ts: iso(now - 30000), kind: 'ask', data: { text: 'A new task' } },
    { id: 'e2', ts: iso(now - 20000), kind: 'card-bump', data: { key: 't/A5' } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  const { claude, launched } = launchingBoard(dir, siteDir);
  // An installed Codex that isn't logged in (HOME has no .codex/auth.json), whatever the machine has.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  put(path.join(bin, 'codex'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, KICKFLIP_CODEX: 'true', KICKFLIP_CLAUDE: claude });
  const pulls = () => launched('build');
  const thread = (id) => lines(path.join(dataDir, 'threads', `t__${id}.jsonl`)).map((l) => l.text);
  // The server writes the wave file too, so a change reads it fresh.
  const closeCard = (id) => { const current = JSON.parse(fs.readFileSync(waveFile, 'utf8')); Object.assign(current.items.find((it) => it.id === id), { lane: 'done', closed_at: iso(clock.at) }); put(waveFile, JSON.stringify(current)); };
  const record = (id, extra) => { const file = path.join(dataDir, 'agents', `${id}.json`); put(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra })); };
  const finish = (id) => { record(id, { done: iso(now) }); closeCard(id); };
  const board = server(t, siteDir);
  // At start the running build takes one of the two slots; the top pullable card takes the other.
  await board.start();
  assert.deepEqual(pulls(), ['t/A5']);
  assert.deepEqual(thread('A5').slice(0, 2).map((t) => t.replace(/ in .*/, '')), ['Moved to In Progress: slot available']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'agents', 'A5.json'), 'utf8')).dispatched, 'hub');
  assert.ok(!fs.readFileSync(eventsFile, 'utf8').includes('card-pull'), 'no event wakes the session');
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: the pull and
  // the pick it started on are in the board's audit log, with what each read.
  const logged = lines(path.join(dataDir, 'audit.jsonl'));
  const pull = logged.find((e) => e.call === 'pull' && e.key === 't/A5');
  assert.deepEqual([pull.key, pull.result, pull.reason, pull.inputs.cap, pull.inputs.pullable.includes('t/A5')], ['t/A5', 'started', 'An implementer slot was free and it was the top ready task in Todo.', 2, true]);
  const pick = logged.find((e) => e.call === 'builder-pick');
  assert.deepEqual([pick.key, pick.result, pick.inputs.dispatch, pick.inputs.codex], ['t/A5', 'claude opus', 'hub', 'not logged in']);
  assert.ok(logged.indexOf(pick) < logged.indexOf(pull), 'the pick is logged as the start makes it, the pull once the start returns');
  // docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a ready card whose title its PR can't take is refused
  // once, naming the retitle, and stays in Todo.
  assert.equal(thread('A8').length, 1);
  assert.equal(thread('A8')[0], "Couldn't start implementing: its title isn't <type>(<scope>): <summary>; retitle it");
  const [refusal] = lines(path.join(dataDir, 'threads', 't__A8.jsonl'));
  assert.match(refusal.detail, /; retitle it with item set t\/A8 --title "<type>\(<scope>\): <summary>" before it goes into In Progress$/);
  assert.deepEqual(logged.filter((e) => e.key === 't/A8').map((e) => [e.call, e.result]), [['pull', 'refused']]);
  await board.stop();
  fs.rmSync(pulledFile, { force: true });
  await board.start();
  await board.minute();
  assert.deepEqual(pulls(), ['t/A5'], 'a started build holds its slot without the marker');
  assert.equal(thread('A8').length, 1, 'the refusal is not posted again while it is the newest line');

  // docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md: A0's build handing back leaves the
  // card In Progress, waiting in Orchestrator review, so it keeps its slot until it lands.
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now), handed_back: iso(now) }));
  await board.changed(agentFile);
  assert.deepEqual(pulls(), ['t/A5'], 'a card waiting in Orchestrator review holds its slot');
  closeCard('A0');
  await board.changed(waveFile);
  assert.deepEqual(pulls(), ['t/A5', 't/A4'], 'a task landing frees its slot on the change');

  // Changed while the server is down: A5 landing frees its slot.
  await board.stop();
  finish('A5');
  await board.start();
  assert.deepEqual(pulls(), ['t/A5', 't/A4', 't/A6'], 'a task closed while the server was down frees its slot');

  put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
  finish('A4');
  await board.changed(waveFile);
  await board.minute();
  assert.deepEqual(pulls(), ['t/A5', 't/A4', 't/A6']);
  fs.rmSync(usageFile);
  await board.minute();
  assert.deepEqual(pulls(), ['t/A5', 't/A4', 't/A6', 't/A7'], 'the pull waits for the pause to end');
  assert.deepEqual(['A1', 'A2', 'A3'].map(thread), [[], [], []]);
  assert.deepEqual(thread('F1'), ['Filed from t/A0: it starts discussing.'], 'the follow-up, filed with no phase, is no pull: it started discussing');
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test('a starting server turns a waiting Implement ask into staging, starts nothing for it, and launches the briefed round of a card sent back from staging, once', async (t) => {
  const { dir, siteDir, dataDir } = scratch(t, 'staging-round', Date.now());
  const waveFile = path.join(dataDir, 'items.json');
  const now = Date.now();
  fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  put(waveFile, JSON.stringify({ items: [
    { id: 'Q1', title: 'Asked', phase: 'grilling', implement_at: iso(now - 60000) },
    { id: 'G1', title: 'Again', phase: 'grilling', briefs: [{ kind: 'grill', at: iso(now - 30000), brief: { heading: 'Brief for grill round 2', text: 'Ask about the edge.', at: iso(now - 20000) } }] },
  ] }));
  put(path.join(dataDir, 'agents', 'G1.json'), JSON.stringify({ kind: 'grill', started: iso(now - 120000), done: iso(now - 90000) }));
  const { claude, launched } = launchingBoard(dir, siteDir, { stays: true });
  Object.assign(process.env, { KICKFLIP_CODEX: 'true', KICKFLIP_CLAUDE: claude });
  await server(t, siteDir).start();
  assert.deepEqual(launched('grill'), ['t/G1'], 'the round sent back from staging launches from its brief');
  const g1 = JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === 'G1');
  assert.deepEqual([g1.briefs, JSON.parse(fs.readFileSync(path.join(dataDir, 'agents', 'G1.json'), 'utf8')).brief.brief.heading], [undefined, 'Brief for grill round 2'], 'the launch takes the brief off the task onto the record');
  assert.ok(!fs.existsSync(path.join(dataDir, 'threads', 't__G1.jsonl')), 'the round posts no thread line of its own');
  const q1 = JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === 'Q1');
  assert.deepEqual([q1.phase, q1.staged_at, q1.implement_at], ['staging', iso(now - 60000), undefined]);
  assert.deepEqual(launched('claude', 'codex', 'prototype'), [], 'a staging task starts nothing');
});

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
test('with auto-triage on, a board sends overnight-triage once a night from the middle of quiet hours, when two cards wait on your answers and nothing builds', async (t) => {
  const { dir, siteDir, dataDir, clock } = scratch(t, 'auto-triage', Date.parse('2026-11-02T16:00:00Z'), { TZ: 'UTC' });
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const usageFile = path.join(home, '.claude', 'kickflip', 'usage.json');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardFile = path.join(siteDir, 'board.json');
  // A0 In Progress holds one slot (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md), the
  // day's pull takes the other.
  put(boardFile, JSON.stringify({ items: 'data/items.json', slug: 't', max_implementers: 2 }));
  // The hub's Triage overnight switch (docs/adr/2026-11-16-0100-one-hub-triage-overnight-switch-replaces-the-board-toggle.md): on unless settings.json stores it off.
  const triageOn = (on) => put(path.join(home, '.claude', 'kickflip', 'settings.json'), JSON.stringify(on ? {} : { overnight: { triage: false } }));
  triageOn(false);
  const wave = { items: [
    { id: 'A0', title: 'feat: running', lane: 'progress' },
    { id: 'A1', title: 'feat: one', lane: 'todo', phase: 'ready' },
    { id: 'A2', title: 'feat: two', lane: 'todo' },
    { id: 'A3', title: 'feat: three', lane: 'todo' },
  ] };
  const writeWave = () => put(waveFile, JSON.stringify(wave));
  writeWave();
  const agent = (done) => put(agentFile, JSON.stringify({ kind: 'codex', started: iso(clock.at - 60000), ...(done ? { done: iso(clock.at) } : {}) }));
  agent(true);
  const question = (id, key) => ({ id, topic: `item:${key}`, question: 'Which?', options: [{ id: 'a', label: 'A' }] });
  const ask = (id, key) => { const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); owner.items.push(question(id, key)); put(ownerFile, JSON.stringify(owner)); };
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [], items: [question('q1', 't/A2')] }));
  fs.writeFileSync(eventsFile, '');
  const triages = () => lines(eventsFile).filter((e) => e.kind === 'overnight-triage');
  const { claude, launched } = launchingBoard(dir, siteDir);
  Object.assign(process.env, { KICKFLIP_CODEX: 'true', KICKFLIP_CLAUDE: claude });
  const pulls = () => launched('build');
  const reply = (id) => { fs.mkdirSync(path.join(dataDir, 'replies'), { recursive: true }); const file = path.join(dataDir, 'replies', `${id}.html`); put(file, '<p>Triaged.</p>'); return file; };
  const board = server(t, siteDir);
  await board.start();
  clock.set(Date.parse('2026-11-03T03:00:00Z'));
  ask('q2', 't/A3');
  await board.changed(ownerFile);
  await board.minute();
  assert.deepEqual(triages(), [], 'off at the hub');

  clock.set(Date.parse('2026-11-02T16:00:00Z'));
  triageOn(true);
  await board.changed(boardFile);
  assert.deepEqual(pulls(), ['t/A1'], 'the day\'s pull');
  await board.minute();
  assert.deepEqual(triages(), [], 'never in the day');
  // The fake builder exits at once, so the minute check relaunches it once and then hands it back (reviveHeadless); the
  // swap below waits for that, or a relaunch under load would rewrite the record the swap removes. That waits on the
  // process's exit, which settled() can't see, so it runs the minute until the hand-back shows.
  const tracked = path.join(dataDir, 'headless-builders.json');
  await until(async () => { await board.minute(); return fs.existsSync(tracked) && JSON.parse(fs.readFileSync(tracked, 'utf8'))['t/A1']?.handedBack; }, 'the exited builder is handed back');
  // A0's builder starts before the pulled build goes back to Todo unstarted, held so it isn't pulled again: the server
  // reads these files as they change, and between the two it would see an idle board.
  agent(false);
  fs.rmSync(path.join(dataDir, 'agents', 'A1.json'));
  wave.items[1].held = true;
  writeWave();
  await board.changed(agentFile, waveFile);
  clock.set(Date.parse('2026-11-03T02:59:00Z'));
  await board.minute();
  assert.deepEqual(triages(), [], 'never before the middle of quiet hours');
  clock.set(Date.parse('2026-11-03T03:00:00Z'));
  await board.minute();
  assert.deepEqual(triages(), [], 'a running builder holds it');

  agent(true);
  await board.changed(agentFile);
  await board.minute();
  assert.equal(triages().length, 1, 'the idle board triages overnight');
  const [first] = triages();
  assert.deepEqual({ ...first.data, cards: first.data.cards.sort() }, { date: '2026-11-03', topic: 'overnight-triage-2026-11-03', cards: ['t/A2', 't/A3'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).topics, [{ id: 'overnight-triage-2026-11-03', title: 'Overnight triage 2026-11-03' }]);
  // The triage's own changes wait for its reply.
  wave.items[2].title = 'feat: two, merged with a duplicate';
  writeWave();
  const markerFile = path.join(dataDir, 'triaged.json');
  await board.changed(waveFile);
  assert.ok(fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8').includes('merged with a duplicate'), 'the server saw the triage\'s own change');
  await board.changed(reply(first.id));
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(triages().length, 1, 'once a night, across a restart');

  clock.set(Date.parse('2026-11-04T03:00:00Z'));
  await board.minute();
  assert.equal(triages().length, 1, 'a night with nothing changed since the triage sends none');

  clock.set(Date.parse('2026-11-04T12:00:00Z'));
  ask('q3', 't/A1');
  await board.changed(ownerFile);
  await board.minute();
  clock.set(Date.parse('2026-11-04T08:00:00Z'));
  await board.minute();
  assert.equal(triages().length, 1, 'never once quiet hours end');
  clock.set(Date.parse('2026-11-05T03:00:00Z'));
  await board.minute();
  assert.equal(triages().length, 2, 'the minute check sends a changed board\'s triage the next night');
  const second = triages()[1].data;
  assert.deepEqual({ ...second, cards: second.cards.sort() }, { date: '2026-11-05', topic: 'overnight-triage-2026-11-05', cards: ['t/A1', 't/A2', 't/A3'] });
  await board.changed(reply(triages()[1].id));

  wave.items[1].title = 'feat: one, renamed';
  put(usageFile, JSON.stringify({ claude: { at: '2026-11-06T03:00:00.000Z', five_hour: { used_percentage: 95, resets_at: '2026-11-06T09:00:00.000Z' }, seven_day: { used_percentage: 40, resets_at: '2026-11-09T00:00:00.000Z' } } }));
  clock.set(Date.parse('2026-11-06T03:00:00Z'));
  writeWave();
  await board.changed(waveFile);
  await board.minute();
  assert.equal(triages().length, 2, 'nothing while paused');
  fs.rmSync(usageFile);
  await board.minute();
  assert.equal(triages().length, 3, 'the triage goes once the pause lifts');
  assert.equal(triages()[2].data.date, '2026-11-06');
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test('an idle board with auto review on sends pr-review for one incoming PR at a time, asked first, never while a builder runs or usage is paused', async (t) => {
  const { siteDir, dataDir, clock } = scratch(t, 'auto-review', Date.parse('2026-11-03T16:00:00Z'), { KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true' });
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const agentFile = path.join(dataDir, 'agents', 'A1.json');
  const usageFile = path.join(home, '.claude', 'kickflip', 'usage.json');
  const now = clock.at;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardFile = path.join(siteDir, 'board.json');
  const boardJSON = (on) => put(boardFile, JSON.stringify({ items: 'data/items.json', slug: 't', auto_review: on }));
  boardJSON(false);
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress' }] }));
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000) }));
  const pr = (number, asked) => ({ number, title: `PR ${number}`, author: 'quinn', url: `https://github.com/o/r/pull/${number}`, head: `h${number}`, touches: ['t/A1'], asked });
  fs.writeFileSync(path.join(dataDir, 'incoming.json'), JSON.stringify({ at: iso(now), repo: 'o/r', prs: [pr(440, false), pr(442, true)] }));
  fs.writeFileSync(eventsFile, '');
  const paused = () => put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
  paused();
  const sent = () => lines(eventsFile).filter((e) => e.kind === 'pr-review').map((e) => e.data);
  const board = server(t, siteDir);
  await board.start();
  fs.rmSync(usageFile);
  await board.minute();
  assert.deepEqual(sent(), [], 'off by default');
  boardJSON(true);
  await board.changed(boardFile);
  await board.minute();
  assert.deepEqual(sent(), [], 'a running builder keeps the board from being idle');
  paused();
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
  await board.changed(agentFile);
  await board.minute();
  assert.deepEqual(sent(), [], 'nothing while paused');
  fs.rmSync(usageFile);
  await board.minute();
  assert.equal(sent().length, 1, 'the idle board asks for a review');
  assert.deepEqual(sent()[0], { pr: 442, head: 'h442', repo: 'o/r', title: 'PR 442', author: 'quinn', url: 'https://github.com/o/r/pull/442', touches: ['t/A1'], asked: true });
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(sent().length, 1, 'one at a time, across a restart');
  const reviews = path.join(dataDir, 'reviews.json');
  put(reviews, JSON.stringify({ 442: { ...pr(442, true), state: 'posted', text: 'Fine.', at: iso(now + 1000) } }));
  await board.changed(reviews);
  assert.equal(sent().length, 2, 'the next PR follows the recorded review');
  assert.equal(sent()[1].pr, 440);
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test("a question's prototype request still waiting 30 minutes on with no prototype agent running is raised as prototype-overdue, once across a restart", async (t) => {
  const { siteDir, dataDir, clock } = scratch(t, 'prototype-overdue', Date.parse('2026-10-30T10:00:00Z'));
  const eventsFile = path.join(dataDir, 'events.jsonl');
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
  fs.writeFileSync(path.join(dataDir, 'owner.json'), JSON.stringify({ items: [{ id: 'q0', topic: 'item:t/A1', question: 'Where?', options: [{ id: 'A', label: 'Top' }] }] }));
  const since = iso(clock.at - 20 * 60000);
  fs.writeFileSync(eventsFile, JSON.stringify({ id: 'r1', ts: since, kind: 'prototype-request', data: { key: 't/A1', question: 'q0', note: '' } }) + '\n');
  const overdue = () => lines(eventsFile).filter((e) => e.kind === 'prototype-overdue').map((e) => e.data);
  const board = server(t, siteDir);
  await board.start();
  await board.minute();
  assert.deepEqual(overdue(), [], 'twenty minutes in, it still waits quietly');
  clock.advance(11);
  await board.minute();
  assert.deepEqual(overdue(), [{ key: 't/A1', request: 'r1', question: 'q0', since }], 'the request is raised past 30 minutes');
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(overdue().length, 1);
});

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
test('a card that comes to wait on the orchestrator wakes the session, again every 15 minutes until picked up and hourly after, and pushes the owner once 30 minutes on, across a restart', async (t) => {
  const { dir, siteDir, dataDir, clock } = scratch(t, 'orchestrator-waits', Date.parse('2026-10-30T10:00:00Z'));
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const waitsFile = path.join(dataDir, 'orchestrator-waits.json');
  const calls = path.join(dir, 'push-calls.jsonl');
  fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  const handedAt = iso(clock.at - 5 * 60000);
  const itemsFile = path.join(dataDir, 'items.json');
  fs.writeFileSync(itemsFile, JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress' }, { id: 'A2', title: 'Two', phase: 'discussing' }] }));
  const build = { kind: 'claude', started: iso(clock.at - 60 * 60000), calls: [{ at: handedAt, text: 'Kept the old name' }] };
  const buildFile = path.join(dataDir, 'agents', 'A1.json');
  fs.writeFileSync(buildFile, JSON.stringify(build));
  const threadFile = path.join(dataDir, 'threads', 't__A1.jsonl');
  fs.writeFileSync(threadFile, JSON.stringify({ ts: iso(clock.at - 60000), kind: 'status', text: 'Building' }) + '\n');
  fs.writeFileSync(eventsFile, '');
  fs.writeFileSync(path.join(dir, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  Object.assign(process.env, { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls });
  const wakes = () => lines(eventsFile).filter((e) => e.kind === 'orchestrator-waits').map((e) => e.data);
  const pushes = () => lines(calls);
  const flag = (call, name) => call[call.indexOf(`--${name}`) + 1];
  const waits = () => { try { return JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits; } catch { return null; } };
  const board = server(t, siteDir);
  await board.start();
  assert.deepEqual(waits(), [], 'a live builder owns the task');
  // builder done hands it back with its calls: no event of its own, yet the list wakes the session.
  put(buildFile, JSON.stringify({ ...build, done: handedAt, handed_back: handedAt }));
  put(itemsFile, JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress', next: "Verify the builder's judgment calls" }, { id: 'A2', title: 'Two', phase: 'discussing' }] }));
  await board.changed(buildFile, itemsFile);
  assert.equal(wakes().length, 1, 'the hand-back wakes the session');
  assert.deepEqual(wakes(), [{ opened: [{ key: 't/A1', ref: 'A1', title: 'One', kind: 'calls', since: handedAt, picked: null }], again: [] }]);
  assert.deepEqual(waits().map((w) => [w.key, w.kind, w.since, w.picked, w.bumped]), [['t/A1', 'calls', handedAt, null, iso(clock.at)]]);
  assert.equal(pushes().length, 0, 'five minutes in, no push');
  await board.minute();
  assert.equal(wakes().length, 1, 'once');
  const { next } = waits()[0];
  assert.match(next, /^Verify the builder's judgment calls: read each with builder calls t\/A1 /);
  const again = { key: 't/A1', ref: 'A1', kind: 'calls', since: handedAt, next };
  clock.advance(14);
  await board.minute();
  assert.equal(wakes().length, 1, 'not yet 15 minutes since the wake');
  clock.advance(1);
  await board.minute();
  assert.equal(wakes().length, 2, 'woken again 15 minutes on');
  assert.deepEqual(wakes()[1], { opened: [], again: [again] });
  clock.advance(11);
  await board.minute();
  assert.equal(pushes().length, 0, 'no push 30 minutes on: the reminder is the re-wake');
  assert.equal(waits()[0].pushed, undefined);
  assert.equal(wakes().length, 2, 'nothing wakes at 30 minutes');
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(wakes().length, 2, 'no wake after a restart before its time');
  assert.equal(pushes().length, 0, 'no push after a restart');
  clock.advance(4);
  await board.minute();
  assert.equal(wakes().length, 3, 'the restart kept the last wake: woken 15 minutes after it');
  assert.deepEqual(wakes()[2], { opened: [], again: [again] });
  // The session's thread line picks it up: it stays on the list, picked, and wakes nothing for an hour from the pickup.
  const picked = iso(clock.at);
  put(threadFile, JSON.stringify({ ts: picked, who: 'claude', text: 'Checking the calls.' }) + '\n');
  await board.changed(threadFile);
  assert.equal(waits()[0].picked, picked, 'picked up');
  clock.advance(59);
  await board.minute();
  assert.equal(wakes().length, 3, 'picked up: quiet for the hour');
  clock.advance(1);
  await board.minute();
  assert.equal(wakes().length, 4, 'still open an hour after the pickup');
  assert.deepEqual(wakes()[3], { opened: [], again: [again] });
  await board.minute();
  assert.equal(wakes().length, 4, 'one wake per due time');
});

// docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md
test('once a day is over the board names the waits that sat over 15 minutes unpicked that day to the orchestrator in a long-waits event, once, pushing nothing, and nothing on its first day or for a day without one', async (t) => {
  const day = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const { dir, siteDir, dataDir, clock } = scratch(t, 'long-waits', day(14, 10));
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const calls = path.join(dir, 'push-calls.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [] }));
  fs.writeFileSync(path.join(dir, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  Object.assign(process.env, { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls });
  const rec = (key, kind, since, picked, cleared) => ({ key, ref: key.slice(2), title: key, kind, since: iso(since), picked: picked && iso(picked), cleared: iso(cleared) });
  const history = (...cleared) => cleared.map((c) => JSON.stringify({ ts: c.cleared, kind: 'waits-history', data: { opened: [], cleared: [c] } }) + '\n').join('');
  fs.writeFileSync(eventsFile, history(rec('t/A1', 'calls', day(14, 9), day(14, 9, 3), day(14, 9, 10))));
  const named = () => lines(eventsFile).filter((e) => e.kind === 'long-waits').map((e) => e.data);
  const board = server(t, siteDir);
  await board.start();
  await board.minute();
  assert.deepEqual(named(), [], 'the first day starts the count, naming nothing');
  fs.appendFileSync(eventsFile, history(rec('t/T5', 'intake', day(14, 11), day(14, 11, 40), day(14, 12)), rec('t/A2', 'calls', day(14, 13), null, day(14, 13, 20))));
  clock.set(day(14, 23, 59));
  await board.minute();
  assert.deepEqual(named(), [], 'not before the day is over');
  clock.set(day(15, 0, 1));
  await board.minute();
  assert.deepEqual(named(), [{ day: '2026-11-14', waits: [
    { key: 't/T5', ref: 'T5', kind: 'intake', since: iso(day(14, 11)), unpicked: 40 * 60000 },
    { key: 't/A2', ref: 'A2', kind: 'calls', since: iso(day(14, 13)), unpicked: 20 * 60000 },
  ] }]);
  await board.stop();
  await board.start();
  await board.minute();
  assert.equal(named().length, 1, 'once, across a restart');
  clock.set(day(16, 0, 1));
  await board.minute();
  assert.equal(named().length, 1, 'a day with no long wait names nothing');
  assert.deepEqual(lines(calls), [], 'nothing goes to the phone');
});

// docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md
test('an event no task holds stays on the orchestrator list past its wake, wakes again 15 minutes on, never pushes, and leaves once its command records it', async (t) => {
  const { dir, siteDir, dataDir, clock } = scratch(t, 'event-waits', Date.parse('2026-11-15T10:00:00Z'));
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const waitsFile = path.join(dataDir, 'orchestrator-waits.json');
  const reviewsFile = path.join(dataDir, 'reviews.json');
  const calls = path.join(dir, 'push-calls.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  const itemsFile = path.join(dataDir, 'items.json');
  fs.writeFileSync(itemsFile, JSON.stringify({ items: [{ id: 'A1', title: 'Architecture review of r', phase: 'discussing' }] }));
  fs.writeFileSync(path.join(dataDir, 'incoming.json'), JSON.stringify({ repo: 'o/r', prs: [{ number: 12, title: 'Fix limiter', head: 'aaa' }, { number: 13, title: 'Held', head: 'bbb' }] }));
  const held = { 13: { number: 13, head: 'bbb', state: 'needs', text: 'Held', at: iso(clock.at - 60000) } };
  fs.writeFileSync(reviewsFile, JSON.stringify(held));
  fs.writeFileSync(eventsFile, '');
  fs.writeFileSync(path.join(dir, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  Object.assign(process.env, { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls });
  const wakes = () => lines(eventsFile).filter((e) => e.kind === 'orchestrator-waits').map((e) => e.data);
  const pushes = () => lines(calls);
  const flag = (call, name) => call[call.indexOf(`--${name}`) + 1];
  const ids = new Set(['p1', 'r1', 'a1', 's1']);
  const waits = () => JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits.filter((w) => ids.has(w.key)).map((w) => [w.key, w.kind, w.ref, w.picked]);
  const append = (e) => fs.appendFileSync(eventsFile, JSON.stringify({ ts: iso(clock.at), ...e }) + '\n');
  const board = server(t, siteDir);
  await board.start();
  append({ id: 'p1', kind: 'pr-review', data: { pr: 12, head: 'aaa', title: 'Fix limiter' } });
  append({ id: 'r1', kind: 'review-answer', data: { pr: 13, answer: 'post' } });
  append({ id: 'a1', kind: 'arch-review', data: { key: 't/A1', repo: '/code/r', branch: 'main' } });
  append({ id: 's1', kind: 'slack-question', data: { reviewer: 'Ann', from: 'reviewer', answer: true } });
  await board.changed(eventsFile);
  assert.deepEqual(wakes().at(-1).opened.map((w) => w.key), ['p1', 'r1', 'a1', 's1']);
  assert.deepEqual(waits(), [['p1', 'pr-review', 'PR #12', null], ['r1', 'review-answer', 'PR #13', null], ['a1', 'arch-review', 'A1', null], ['s1', 'slack-question', 'Slack · Ann', null]]);
  // The watcher printing the events changes nothing: each stays until its own command runs.
  const woken = wakes().length;
  clock.advance(15);
  await board.minute();
  assert.equal(wakes().length, woken + 1);
  assert.deepEqual(wakes().at(-1).again.filter((w) => ids.has(w.key)).map((w) => [w.key, w.kind]), [['p1', 'pr-review'], ['r1', 'review-answer'], ['a1', 'arch-review'], ['s1', 'slack-question']], 'a re-wake repeats each');
  assert.match(wakes().at(-1).again[0].next, /review post 12/);
  clock.advance(15);
  await board.minute();
  assert.deepEqual(pushes(), [], 'no push 30 minutes on');
  // review post and review record write reviews.json; the audit task closes with no findings; slack answer appends
  // slack-handled.
  put(reviewsFile, JSON.stringify({ 12: { number: 12, head: 'aaa', state: 'posted', text: 'Fine', at: iso(clock.at + 1000) }, 13: { ...held[13], state: 'posted', at: iso(clock.at + 1000) } }));
  await board.changed(reviewsFile);
  await board.minute();
  assert.deepEqual(waits().map(([key]) => key), ['a1', 's1']);
  put(itemsFile, JSON.stringify({ items: [{ id: 'A1', title: 'Architecture review of r', lane: 'done' }] }));
  await board.changed(itemsFile);
  assert.deepEqual(waits().map(([key]) => key), ['s1']);
  append({ id: 'h1', kind: 'slack-handled', data: { id: 's1', by: 'answer' } });
  await board.changed(eventsFile);
  assert.deepEqual(waits(), []);
});

// docs/adr/2026-11-15-0010-the-minute-pass-signals-a-write-the-file-watch-dropped.md
test('a write the file watch never reports is signalled to pages at the next minute pass, once', async (t) => {
  const { siteDir, dataDir, clock } = scratch(t, 'dropped-write', Date.parse('2026-11-14T10:00:00Z'));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'owner.json'), '{"items":[]}');
  const itemsFile = path.join(dataDir, 'items.json');
  put(itemsFile, JSON.stringify({ items: [{ id: 'A1', lane: 'todo', title: 'One' }] }));
  const b = await startBoard(t, { site: siteDir });
  await b.settled();
  let changes = 0;
  const page = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/stream', headers: {} });
  b.server.emit('request', page, {
    writeHead() { return this; },
    write(text) { if (text.includes('event: change')) changes++; },
  });
  const minute = async () => { clock.advance(1); b.minute(); await b.settled(); };
  await minute();
  const quiet = changes;
  put(itemsFile, JSON.stringify({ items: [{ id: 'A1', lane: 'todo', title: 'Renamed' }] }));
  await minute();
  assert.equal(changes, quiet + 1, 'the minute pass signals the write the watch never reported');
  // The passes the signal runs mark the card they saw arrive, a write the next minute stamps; after it, nothing moves.
  await minute();
  const settled = changes;
  await minute();
  assert.equal(changes, settled, 'a minute with no write signals nothing');
});
