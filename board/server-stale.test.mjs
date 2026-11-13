import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { until, untilHeard, boardListening, untilTestEnds, stallingPs } from '../shared/test-helpers.mjs';
import { writeBrief } from './store.mjs';

// Writes a file the running server may be reading the way the board does (write aside, then rename), so the server
// never reads it half-written.
const put = (file, text) => { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); };

// The board at siteDir as the hub's manifest under dir records it, building from a git repo of its own, and a fake
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
  const manifest = path.join(dir, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { t: { dir: siteDir, port: 1, cmd: ['node', '/x/board/server.mjs'], branch: 'main', owner: { repo } } } }));
  const log = path.join(dir, 'launches.log');
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(claude, `#!/usr/bin/env node\nconst m = process.argv[3].match(/builder start (\\S+) --kind (\\w+)/);\nrequire('fs').appendFileSync(${JSON.stringify(log)}, m[1] + ' ' + m[2] + '\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid }));\n${stays ? `${untilTestEnds()};\n` : ''}`);
  fs.chmodSync(claude, 0o755);
  const launched = (...kinds) => [...new Set((fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, k]) => kinds.includes(k)).map(([key]) => key))];
  return { claude, launched };
}

// docs/adr/2026-11-05-0200-a-stale-review-and-a-silent-builder-join-the-orchestrator-list.md
test('a silent builder wakes the session once per silent spell through the orchestrator list, across a restart, and stops on done', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-stale-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waitsFile = path.join(dataDir, 'orchestrator-waits.json');
  const agentFile = path.join(dataDir, 'agents', 'A1.json');
  let now = Date.parse('2026-10-30T10:00:00Z');
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', lane: 'progress', title: 'One' }] }));
  const started = new Date(now - 9 * 60000).toISOString();
  fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started }));
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const waits = () => { try { return JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits; } catch { return null; } };
  const wakes = () => {
    const text = fs.existsSync(path.join(dataDir, 'events.jsonl')) ? fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8') : '';
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'orchestrator-waits').map((e) => e.data);
  };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
  const advance = (minutes) => { now += minutes * 60000; put(clockFile, String(now)); };
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  await tick();
  assert.equal(wakes().length, 0);
  advance(2);
  await until(() => wakes().length === 1, 'the silent builder wakes the session');
  assert.deepEqual(waits().map((w) => [w.key, w.kind, w.since]), [['t/A1', 'stale', started]]);
  await stop();
  await start();
  await tick();
  await tick();
  assert.equal(wakes().length, 1, 'once across a restart');

  const progress = new Date(now).toISOString();
  put(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: progress, kind: 'status', text: 'Running tests' }) + '\n');
  await until(() => waits().length === 0, 'progress ends the wait');
  advance(31);
  await until(() => wakes().length === 2, 'the next silent spell wakes it again');
  assert.equal(waits()[0].since, progress);

  put(agentFile, JSON.stringify({ kind: 'codex', started, done: new Date(now).toISOString() }));
  await until(() => waits().every((w) => w.kind !== 'stale'), 'finishing the builder ends the wait');
  advance(60);
  await tick();
  assert.ok(waits().every((w) => w.kind !== 'stale'), 'no silent-builder wait after done');
});

test('a held card resumes itself within a minute of its pick-up time, once per time across a restart, announcing card-unblocked unless a dep is unfinished', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-up-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  let now = Date.parse('2026-11-04T16:30:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const at = iso(now + 30 * 60000);
  let worker;
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(waveFile, JSON.stringify({ items: [
    { id: 'A0', title: 'Dep', lane: 'progress' },
    { id: 'A1', title: 'Timed', lane: 'todo', held: true, pick_up_at: at, held_at: iso(now - 60000) },
    { id: 'A2', title: 'Blocked', deps: ['A0'], held: true, pick_up_at: at, held_at: iso(now - 60000) },
    { id: 'A3', title: 'Tapped', lane: 'todo' },
    { id: 'A4', title: 'Forever', lane: 'todo', held: true, held_at: iso(now - 60000) },
    { id: 'A5', title: 'Cut short', lane: 'todo', held: true, pick_up_at: at, held_at: iso(now - 60000) },
  ] }));
  fs.writeFileSync(eventsFile, [
    { id: 'e1', ts: iso(now - 30000), kind: 'card-hold', data: { key: 't/A3', hold: true, until: at } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const items = () => Object.fromEntries(read(waveFile, { items: [] }).items.map((it) => [it.id, it]));
  const unblocked = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'card-unblocked').map((e) => e.data);
  const threadLines = (id) => (fs.existsSync(path.join(dataDir, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(dataDir, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').length : 0);
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  await tick();
  assert.deepEqual(unblocked(), []);
  assert.equal(items().A1.held, true);
  await stop();

  fs.appendFileSync(eventsFile, JSON.stringify({ id: 'e2', ts: iso(now), kind: 'card-unblocked', data: { key: 't/A5', until: at } }) + '\n');
  now += 31 * 60000;
  fs.writeFileSync(clockFile, String(now));
  await start();
  await until(() => !items().A1.held && !items().A2.held && !items().A5.held && items().A3.held_at, 'the due holds resume');
  assert.deepEqual(unblocked().map((d) => [d.key, d.until]).sort(), [['t/A1', at], ['t/A3', at], ['t/A5', at]]);
  assert.deepEqual(['A1', 'A2', 'A3', 'A5'].map(threadLines), [1, 1, 1, 0]);
  assert.deepEqual([items().A1.pick_up_at, items().A4.held], [undefined, true]);
  await stop();
  await start();
  await tick();
  assert.equal(unblocked().length, 3);
  assert.deepEqual(['A1', 'A2', 'A3', 'A5'].map(threadLines), [1, 1, 1, 0]);
});

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
test('with auto implement on the board starts and launches the build of the top pullable Todo cards at start and on each change, filling free slots up to Maximum parallel implementers, once each across a restart, and never while paused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-pull-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const pulledFile = path.join(dataDir, 'pulled.json');
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  const now = Date.parse('2026-11-02T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
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
  const owner = { topics: [], items: [question('q3', 't/A3')] };
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  fs.writeFileSync(eventsFile, [
    { id: 'e1', ts: iso(now - 30000), kind: 'ask', data: { text: 'A new card' } },
    { id: 'e2', ts: iso(now - 20000), kind: 'card-bump', data: { key: 't/A5' } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const { claude, launched } = launchingBoard(dir, siteDir);
  // An installed Codex that isn't logged in (HOME has no .codex/auth.json), whatever the machine has.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  put(path.join(bin, 'codex'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const pulls = () => launched('build');
  const thread = (id) => (fs.existsSync(path.join(dataDir, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(dataDir, 'threads', `t__${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
  // The server writes the wave file too, so a change reads it fresh.
  const close = (id) => { const now = JSON.parse(fs.readFileSync(waveFile, 'utf8')); Object.assign(now.items.find((it) => it.id === id), { lane: 'done', closed_at: iso(Date.now()) }); put(waveFile, JSON.stringify(now)); };
  const record = (id, extra) => { const file = path.join(dataDir, 'agents', `${id}.json`); put(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra })); };
  const finish = (id) => { record(id, { done: iso(now) }); close(id); };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, KICKFLIP_CODEX: 'true', HOME: dir, BUILDER_TEST_CLOCK: clockFile, KICKFLIP_CLAUDE: claude },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // At start the running build takes one of the two slots; the top pullable card takes the other.
  await start();
  await until(() => pulls().length === 1 && thread('A5').length >= 2, 'the board pulls in a card at start');
  assert.deepEqual(pulls(), ['t/A5']);
  // The fake builder exits at once, so the minute check may relaunch it after these two lines.
  assert.deepEqual(thread('A5').slice(0, 2).map((t) => t.replace(/ in .*/, '')), ['Pulled in: an implementer slot was free.', 'Moved to In Progress: a build started']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'agents', 'A5.json'), 'utf8')).dispatched, 'hub');
  assert.ok(!fs.readFileSync(eventsFile, 'utf8').includes('card-pull'), 'no event wakes the session');
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: the pull and
  // the pick it started on are in the board's audit log, with what each read.
  const logged = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const pull = logged.find((e) => e.call === 'pull' && e.key === 't/A5');
  assert.deepEqual([pull.key, pull.result, pull.reason, pull.inputs.cap, pull.inputs.pullable.includes('t/A5')], ['t/A5', 'started', 'An implementer slot was free and it was the top ready card in Todo.', 2, true]);
  const pick = logged.find((e) => e.call === 'builder-pick');
  assert.deepEqual([pick.key, pick.result, pick.inputs.dispatch, pick.inputs.codex], ['t/A5', 'claude opus', 'hub', 'not logged in']);
  assert.ok(logged.indexOf(pick) < logged.indexOf(pull), 'the pick is logged as the start makes it, the pull once the start returns');
  // docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a ready card whose title its PR can't take is refused
  // once, naming the retitle, and stays in Todo.
  assert.equal(thread('A8').length, 1);
  assert.equal(thread('A8')[0], "Couldn't start implementing: its title isn't <type>(<scope>): <summary>; retitle it");
  const [refusal] = fs.readFileSync(path.join(dataDir, 'threads', 't__A8.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.match(refusal.detail, /; retitle it with item set t\/A8 --title "<type>\(<scope>\): <summary>" before it goes into In Progress$/);
  assert.deepEqual(logged.filter((e) => e.key === 't/A8').map((e) => [e.call, e.result]), [['pull', 'refused']]);
  await stop();
  fs.rmSync(pulledFile, { force: true });
  await start();
  await tick();
  assert.deepEqual(pulls(), ['t/A5'], 'a started build holds its slot without the marker');
  assert.equal(thread('A8').length, 1, 'the refusal is not posted again while it is the newest line');

  // The running build finishing frees its slot at once.
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
  await untilHeard(() => pulls().length === 2, 'a freed slot is filled on the change', path.join(dataDir, 'nudge'));
  assert.deepEqual(pulls(), ['t/A5', 't/A4']);

  // Changed while the server is down: A0 waits in Orchestrator review, which takes no slot, so A5 finishing frees one
  // (docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md).
  await stop();
  record('A0', { handed_back: iso(now) });
  finish('A5');
  await start();
  await until(() => pulls().length === 3, 'a card in review holds no slot');
  assert.deepEqual(pulls(), ['t/A5', 't/A4', 't/A6']);
  close('A0');

  put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
  finish('A4');
  await tick();
  await tick();
  assert.deepEqual(pulls(), ['t/A5', 't/A4', 't/A6']);
  fs.rmSync(usageFile);
  await until(() => pulls().length === 4, 'the pull waits for the pause to end');
  assert.deepEqual(pulls(), ['t/A5', 't/A4', 't/A6', 't/A7']);
  assert.deepEqual(['A1', 'A2', 'A3'].map(thread), [[], [], []]);
  // The follow-up, filed with no phase, is no pull but arrived in Todo, so it got its grill.
  assert.deepEqual(thread('F1'), [], 'the arrival posts no thread line of its own');
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test('a starting server turns a waiting Implement ask into staging, starts nothing for it, and launches the briefed round of a card sent back from staging, once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-round-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const waveFile = path.join(dataDir, 'items.json');
  const setup = path.join(dir, 'setup.mjs');
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  let worker;
  fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  put(waveFile, JSON.stringify({ items: [
    { id: 'Q1', title: 'Asked', phase: 'grilling', implement_at: iso(now - 60000) },
    { id: 'G1', title: 'Again', phase: 'grilling', briefs: [{ kind: 'grill', at: iso(now - 30000), brief: { heading: 'Brief for grill round 2', text: 'Ask about the edge.', at: iso(now - 20000) } }] },
  ] }));
  put(path.join(dataDir, 'agents', 'G1.json'), JSON.stringify({ kind: 'grill', started: iso(now - 120000), done: iso(now - 90000) }));
  fs.writeFileSync(setup, "import http from 'node:http'; http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };");
  const { claude, launched } = launchingBoard(dir, siteDir, { stays: true });
  t.after(async () => {
    if (worker?.exitCode === null && worker.signalCode === null) { const exited = new Promise((resolve) => worker.once('exit', resolve)); worker.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], { env: { ...process.env, KICKFLIP_CODEX: 'true', HOME: dir, KICKFLIP_CLAUDE: claude } });
  await boardListening(worker);
  await until(() => launched('grill').length === 1, 'the round sent back from staging launches from its brief');
  assert.deepEqual(launched('grill'), ['t/G1']);
  const g1 = JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === 'G1');
  assert.deepEqual([g1.briefs, JSON.parse(fs.readFileSync(path.join(dataDir, 'agents', 'G1.json'), 'utf8')).brief.brief.heading], [undefined, 'Brief for grill round 2'], 'the launch takes the brief off the card onto the record');
  assert.ok(!fs.existsSync(path.join(dataDir, 'threads', 't__G1.jsonl')), 'the round posts no thread line of its own');
  const q1 = JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === 'Q1');
  assert.deepEqual([q1.phase, q1.staged_at, q1.implement_at], ['staging', iso(now - 60000), undefined]);
  assert.deepEqual(launched('claude', 'codex', 'prototype'), [], 'a staging card starts nothing');
});

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
test('with auto-triage on, a board sends overnight-triage once a night from the middle of quiet hours, when two cards wait on your answers and nothing builds', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-triage-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  let now = Date.parse('2026-11-02T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardJSON = (on) => put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', auto_triage: on, max_implementers: 1 }));
  boardJSON(false);
  const wave = { items: [
    { id: 'A0', title: 'feat: running', lane: 'progress' },
    { id: 'A1', title: 'feat: one', lane: 'todo', phase: 'ready' },
    { id: 'A2', title: 'feat: two', lane: 'todo' },
    { id: 'A3', title: 'feat: three', lane: 'todo' },
  ] };
  const writeWave = () => put(waveFile, JSON.stringify(wave));
  writeWave();
  const agent = (done) => put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), ...(done ? { done: iso(now) } : {}) }));
  agent(true);
  const question = (id, key) => ({ id, topic: `item:${key}`, question: 'Which?', options: [{ id: 'a', label: 'A' }] });
  const ask = (id, key) => { const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); owner.items.push(question(id, key)); put(ownerFile, JSON.stringify(owner)); };
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [], items: [question('q1', 't/A2')] }));
  fs.writeFileSync(eventsFile, '');
  const setClock = (ms) => { now = ms; put(clockFile, String(ms)); };
  setClock(now);
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const logged = (kind) => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === kind);
  const triages = () => logged('overnight-triage');
  const { claude, launched } = launchingBoard(dir, siteDir);
  const pulls = () => launched('build');
  const reply = (id) => { fs.mkdirSync(path.join(dataDir, 'replies'), { recursive: true }); put(path.join(dataDir, 'replies', `${id}.html`), '<p>Triaged.</p>'); };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, KICKFLIP_CODEX: 'true', HOME: dir, TZ: 'UTC', BUILDER_TEST_CLOCK: clockFile, KICKFLIP_CLAUDE: claude },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  setClock(Date.parse('2026-11-03T03:00:00Z'));
  ask('q2', 't/A3');
  await tick();
  assert.deepEqual(triages(), [], 'off by default');

  setClock(Date.parse('2026-11-02T16:00:00Z'));
  boardJSON(true);
  await until(() => pulls().length === 1, 'the day\'s pull');
  await tick();
  assert.deepEqual(triages(), [], 'never in the day');
  // The fake builder exits at once, so the server relaunches it once and then hands it back (reviveHeadless); the
  // swap below waits for that, or a relaunch under load would rewrite the record the swap removes.
  const tracked = path.join(dataDir, 'headless-builders.json');
  await until(() => fs.existsSync(tracked) && JSON.parse(fs.readFileSync(tracked, 'utf8'))['t/A1']?.handedBack, 'the exited builder is handed back');
  // A0's builder starts before the pulled build goes back to Todo unstarted, held so it isn't pulled again: the server
  // reads these files as they change, and between the two it would see an idle board.
  agent(false);
  fs.rmSync(path.join(dataDir, 'agents', 'A1.json'));
  wave.items[1].held = true;
  writeWave();
  setClock(Date.parse('2026-11-03T02:59:00Z'));
  await tick();
  assert.deepEqual(triages(), [], 'never before the middle of quiet hours');
  setClock(Date.parse('2026-11-03T03:00:00Z'));
  await tick();
  await tick();
  assert.deepEqual(triages(), [], 'a running builder holds it');

  agent(true);
  // A wait that times out prints what the server holds, since the temp dir goes with the test.
  const held = () => ['wave.json', 'headless-builders.json', 'pulled.json', 'triaged.json', 'events.jsonl']
    .concat(fs.readdirSync(path.join(dataDir, 'agents')).map((f) => path.join('agents', f)))
    .map((f) => `${f}: ${fs.existsSync(path.join(dataDir, f)) ? fs.readFileSync(path.join(dataDir, f), 'utf8').trim() : '(missing)'}`).join('\n');
  await until(() => triages().length === 1, 'the idle board triages overnight').catch((e) => { throw new Error(`${e.message}\n${held()}`); });
  const [first] = triages();
  assert.deepEqual({ ...first.data, cards: first.data.cards.sort() }, { date: '2026-11-03', topic: 'overnight-triage-2026-11-03', cards: ['t/A2', 't/A3'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).topics, [{ id: 'overnight-triage-2026-11-03', title: 'Overnight triage 2026-11-03' }]);
  // The triage's own changes wait for its reply.
  wave.items[2].title = 'feat: two, merged with a duplicate';
  writeWave();
  const markerFile = path.join(dataDir, 'triaged.json');
  await untilHeard(() => fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8').includes('merged with a duplicate'), 'the server saw the triage\'s own change', path.join(dataDir, 'nudge'));
  reply(first.id);
  await tick();
  await stop();
  await start();
  await tick();
  assert.equal(triages().length, 1, 'once a night, across a restart');

  setClock(Date.parse('2026-11-04T03:00:00Z'));
  await tick();
  await tick();
  assert.equal(triages().length, 1, 'a night with nothing changed since the triage sends none');

  setClock(Date.parse('2026-11-04T12:00:00Z'));
  ask('q3', 't/A1');
  await tick();
  await tick();
  setClock(Date.parse('2026-11-04T08:00:00Z'));
  await tick();
  await tick();
  assert.equal(triages().length, 1, 'never once quiet hours end');
  setClock(Date.parse('2026-11-05T03:00:00Z'));
  await until(() => triages().length === 2, 'the minute check sends a changed board\'s triage the next night');
  const second = triages()[1].data;
  assert.deepEqual({ ...second, cards: second.cards.sort() }, { date: '2026-11-05', topic: 'overnight-triage-2026-11-05', cards: ['t/A1', 't/A2', 't/A3'] });
  reply(triages()[1].id);

  wave.items[1].title = 'feat: one, renamed';
  put(usageFile, JSON.stringify({ claude: { at: '2026-11-06T03:00:00.000Z', five_hour: { used_percentage: 95, resets_at: '2026-11-06T09:00:00.000Z' }, seven_day: { used_percentage: 40, resets_at: '2026-11-09T00:00:00.000Z' } } }));
  setClock(Date.parse('2026-11-06T03:00:00Z'));
  writeWave();
  await tick();
  await tick();
  assert.equal(triages().length, 2, 'nothing while paused');
  fs.rmSync(usageFile);
  await until(() => triages().length === 3, 'the triage goes once the pause lifts');
  assert.equal(triages()[2].data.date, '2026-11-06');
});

// docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md
test('each card arriving in Todo owes a grill brief up to the planner cap and grills from it, busy board or not, the rest in board order, once each, never while paused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-plan-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'items.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const agentFile = (id) => path.join(dataDir, 'agents', `${id}.json`);
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  const now = Date.parse('2026-11-03T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile('B1')), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', max_planners: 2 }));
  const wave = { items: [
    { id: 'B1', title: 'feat: asking', lane: 'todo', phase: 'grilling' },
    { id: 'B2', title: 'feat: filed prototyping', lane: 'todo', phase: 'prototyping' },
    { id: 'B3', title: 'feat: a follow-up', lane: 'todo', phase: 'grilling', parent: 't/B1' },
    { id: 'B4', title: 'feat: past the cap', lane: 'todo' },
    { id: 'B5', title: 'feat: quick build', lane: 'todo', phase: 'ready' },
  ].map((it, n) => ({ ...it, created: iso(now - (n + 1) * 60000) })) };
  fs.writeFileSync(waveFile, JSON.stringify(wave));
  const question = (id, key) => ({ id, topic: `item:${key}`, question: 'Which?', options: [{ id: 'a', label: 'A' }] });
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [], items: [question('q1', 't/B1')] }));
  fs.writeFileSync(eventsFile, '');
  put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const logged = (kind) => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === kind).map((e) => e.data.key);
  const thread = (id) => (fs.existsSync(path.join(dataDir, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(dataDir, 'threads', `t__${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
  const { claude, launched } = launchingBoard(dir, siteDir, { stays: true });
  // The server records a planner's launch on its frozen clock, and reads a planner gone unless its process started in the
  // minute before; this ps says each running process started a second before that clock, so a planner reads gone only
  // once its process has.
  const ps = stallingPs(dir, { lstart: 'Tue Nov  3 15:59:59 2026', ppid: 1 });
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, PATH: `${ps.bin}:${process.env.PATH}`, KICKFLIP_CODEX: 'true', HOME: dir, BUILDER_TEST_CLOCK: clockFile, KICKFLIP_CLAUDE: claude },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  await tick();
  const grills = () => fs.readFileSync(path.join(dir, 'launches.log'), 'utf8').split('\n').filter((l) => l.endsWith(' grill')).length;
  assert.deepEqual(launched('grill', 'prototype', 'build'), [], 'nothing launches while usage is paused');
  fs.rmSync(usageFile);
  const owes = (id) => (JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === id).briefs || []).map((b) => b.kind);
  await until(() => owes('B3').length && owes('B4').length && launched('build').length === 1, 'the arrivals owe their grill briefs');
  assert.deepEqual(['B2', 'B3', 'B4'].map(owes), [[], ['grill'], ['grill']], 'the cap of two takes the top arrivals, Todo being oldest first');
  await tick();
  assert.deepEqual(launched('grill'), [], 'an owed brief launches nothing');
  // The orchestrator writes each arrival's brief (item brief); the board launches its grill from it.
  const brief = (id, kind) => {
    const draft = path.join(dir, `brief-${id}.md`);
    fs.writeFileSync(draft, `What ${id} settled and what is open.`);
    writeBrief(siteDir, `t/${id}`, { kind, file: draft });
  };
  brief('B3', 'grill');
  brief('B4', 'grill');
  await untilHeard(() => launched('grill').length === 2 && fs.existsSync(agentFile('B3')), 'the arrivals get their grills', path.join(dataDir, 'nudge'));
  assert.deepEqual(launched('grill').sort(), ['t/B3', 't/B4']);
  assert.deepEqual(launched('prototype'), [], 'B2, filed prototyping, waits past the cap');
  assert.deepEqual(launched('build'), ['t/B5'], 'a ready card is pulled, not grilled, and its build holds no planner back');
  assert.deepEqual(thread('B3'), ['Grill requested'], "the board posts no line of its own: the orchestrator's brief does");
  const record = JSON.parse(fs.readFileSync(agentFile('B4'), 'utf8'));
  assert.deepEqual([record.kind, record.dispatched], ['grill', 'hub']);
  await stop();
  await start();
  await tick();
  await tick();
  assert.equal(grills(), 2, 'an open grill is not launched again, and B2 waits for a slot');

  // B4's grill posts a question and finishes: its slot goes to B2, the next arrival, which was filed prototyping, so
  // it gets a prototype planner, not a grill.
  put(ownerFile, JSON.stringify({ topics: [], items: [question('q1', 't/B1'), question('q2', 't/B4')] }));
  put(agentFile('B4'), JSON.stringify({ ...record, done: iso(now) }));
  await untilHeard(() => owes('B2').length, 'the next arrival gets the free slot', path.join(dataDir, 'nudge'));
  assert.deepEqual(owes('B2'), ['prototype']);
  brief('B2', 'prototype');
  await untilHeard(() => launched('prototype').length === 1, 'its prototype planner launches from its brief', path.join(dataDir, 'nudge'));
  assert.deepEqual(launched('grill').sort(), ['t/B3', 't/B4']);
  assert.deepEqual(launched('prototype'), ['t/B2']);
  assert.deepEqual([JSON.parse(fs.readFileSync(agentFile('B2'), 'utf8'))].map((r) => [r.kind, r.dispatched]), [['prototype', 'hub']]);
  assert.deepEqual(thread('B2'), ['Prototype requested'], "the board posts no line of its own: the orchestrator's brief does");
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
  const arrivals = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.call === 'arrival-planner');
  assert.deepEqual(arrivals.map((e) => [e.key, e.result, e.reason, e.inputs.phase]).sort(), [
    ['t/B2', 'prototype', 'It landed in Todo filed prototyping.', 'prototyping'],
    ['t/B3', 'grill', 'It landed in Todo, not filed prototyping.', 'grilling'],
    ['t/B4', 'grill', 'It landed in Todo, not filed prototyping.', 'new'],
  ]);
  // B3's grill finishes with no questions: one grill per arrival, so it isn't grilled again.
  put(agentFile('B3'), JSON.stringify({ ...JSON.parse(fs.readFileSync(agentFile('B3'), 'utf8')), done: iso(now) }));
  await tick();
  await tick();
  assert.equal(grills(), 2);
  assert.deepEqual(logged('card-plan'), [], 'no event wakes the session');
  assert.deepEqual(thread('B1'), [], 'a card with questions has had its grill');
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test('an idle board with auto review on sends pr-review for one incoming PR at a time, asked first, never while a builder runs or usage is paused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-review-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const agentFile = path.join(dataDir, 'agents', 'A1.json');
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  const now = Date.parse('2026-11-03T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardJSON = (on) => put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', auto_review: on }));
  boardJSON(false);
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress' }] }));
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000) }));
  const pr = (number, asked) => ({ number, title: `PR ${number}`, author: 'quinn', url: `https://github.com/o/r/pull/${number}`, head: `h${number}`, touches: ['t/A1'], asked });
  fs.writeFileSync(path.join(dataDir, 'incoming.json'), JSON.stringify({ at: iso(now), repo: 'o/r', prs: [pr(440, false), pr(442, true)] }));
  fs.writeFileSync(eventsFile, '');
  put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const sent = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'pr-review').map((e) => e.data);
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  await tick();
  fs.rmSync(usageFile);
  await tick();
  assert.deepEqual(sent(), [], 'off by default');
  boardJSON(true);
  await tick();
  await tick();
  assert.deepEqual(sent(), [], 'a running builder keeps the board from being idle');
  put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
  await tick();
  await tick();
  assert.deepEqual(sent(), [], 'nothing while paused');
  fs.rmSync(usageFile);
  await until(() => sent().length === 1, 'the idle board asks for a review');
  assert.deepEqual(sent()[0], { pr: 442, head: 'h442', repo: 'o/r', title: 'PR 442', author: 'quinn', url: 'https://github.com/o/r/pull/442', touches: ['t/A1'], asked: true });
  await stop();
  await start();
  await tick();
  await tick();
  assert.equal(sent().length, 1, 'one at a time, across a restart');
  put(path.join(dataDir, 'reviews.json'), JSON.stringify({ 442: { ...pr(442, true), state: 'posted', text: 'Fine.', at: iso(now + 1000) } }));
  await until(() => sent().length === 2, 'the next PR follows the recorded review');
  assert.equal(sent()[1].pr, 440);
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test("a question's prototype request still waiting 30 minutes on with no prototype agent running is raised as prototype-overdue, once across a restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-overdue-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  let now = Date.parse('2026-10-30T10:00:00Z');
  let worker;
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
  fs.writeFileSync(path.join(dataDir, 'owner.json'), JSON.stringify({ items: [{ id: 'q0', topic: 'item:t/A1', question: 'Where?', options: [{ id: 'A', label: 'Top' }] }] }));
  const since = new Date(now - 20 * 60000).toISOString();
  fs.writeFileSync(eventsFile, JSON.stringify({ id: 'r1', ts: since, kind: 'prototype-request', data: { key: 't/A1', question: 'q0', note: '' } }) + '\n');
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const overdue = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'prototype-overdue').map((e) => e.data);
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  await tick();
  assert.deepEqual(overdue(), [], 'twenty minutes in, it still waits quietly');
  now += 11 * 60000;
  put(clockFile, String(now));
  await until(() => overdue().length === 1, 'the request is raised past 30 minutes');
  assert.deepEqual(overdue(), [{ key: 't/A1', request: 'r1', question: 'q0', since }]);
  await stop();
  await start();
  await tick();
  assert.equal(overdue().length, 1);
});

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
test('a card that comes to wait on the orchestrator wakes the session, again every 15 minutes until picked up and hourly after, and pushes the owner once 30 minutes on, across a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-waits-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const waitsFile = path.join(dataDir, 'orchestrator-waits.json');
  const calls = path.join(dir, 'push-calls.jsonl');
  let now = Date.parse('2026-10-30T10:00:00Z');
  let worker;
  fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  const handedAt = new Date(now - 5 * 60000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress' }, { id: 'A2', title: 'Two', phase: 'discussing' }] }));
  const build = { kind: 'claude', started: new Date(now - 60 * 60000).toISOString(), calls: [{ at: handedAt, text: 'Kept the old name' }] };
  fs.writeFileSync(path.join(dataDir, 'agents', 'A1.json'), JSON.stringify(build));
  fs.writeFileSync(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: new Date(now - 60000).toISOString(), kind: 'status', text: 'Building' }) + '\n');
  fs.writeFileSync(eventsFile, '');
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(path.join(dir, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const wakes = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'orchestrator-waits').map((e) => e.data);
  // The fake push command may be mid-write, so an empty file or an unfinished last line is no call yet.
  const pushes = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
  const flag = (call, name) => call[call.indexOf(`--${name}`) + 1];
  const waits = () => { try { return JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits; } catch { return null; } };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile, KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls },
    });
    await boardListening(worker);
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  await until(() => waits() !== null, 'the first wait check');
  assert.deepEqual(waits(), [], 'a live builder owns the card');
  // builder done hands it back with its calls: no event of its own, yet the list wakes the session.
  put(path.join(dataDir, 'agents', 'A1.json'), JSON.stringify({ ...build, done: handedAt, handed_back: handedAt }));
  put(path.join(dataDir, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress', next: "Verify the builder's judgment calls" }, { id: 'A2', title: 'Two', phase: 'discussing' }] }));
  await until(() => wakes().length === 1, 'the hand-back wakes the session');
  assert.deepEqual(wakes(), [{ added: ['t/A1'], again: [] }]);
  assert.deepEqual(waits().map((w) => [w.key, w.kind, w.since, w.picked, w.bumped]), [['t/A1', 'calls', handedAt, null, new Date(now).toISOString()]]);
  assert.equal(pushes().length, 0, 'five minutes in, no push');
  await tick();
  assert.equal(wakes().length, 1, 'once');
  const again = { key: 't/A1', ref: 'A1', kind: 'calls', since: handedAt, next: "Verify the builder's judgment calls" };
  const advance = (minutes) => { now += minutes * 60000; put(clockFile, String(now)); };
  advance(14);
  await tick();
  assert.equal(wakes().length, 1, 'not yet 15 minutes since the wake');
  advance(1);
  await until(() => wakes().length === 2, 'woken again 15 minutes on');
  assert.deepEqual(wakes()[1], { added: [], again: [again] });
  advance(11);
  await until(() => pushes().length === 1, 'pushed 30 minutes on');
  assert.equal(flag(pushes()[0], 'title'), 'A1 waits on the orchestrator');
  assert.equal(flag(pushes()[0], 'body'), "One: Verify the builder's judgment calls");
  assert.equal(flag(pushes()[0], 'tag'), 'wait-t/A1');
  await until(() => waits()[0].pushed === true, 'the push is kept');
  assert.equal(wakes().length, 2, 'the push is no wake');
  await stop();
  await start();
  await tick();
  await tick();
  assert.equal(wakes().length, 2, 'no wake after a restart before its time');
  assert.equal(pushes().length, 1, 'no second push after a restart');
  advance(4);
  await until(() => wakes().length === 3, 'the restart kept the last wake: woken 15 minutes after it');
  assert.deepEqual(wakes()[2], { added: [], again: [again] });
  // The session's thread line picks it up: it stays on the list, picked, and wakes nothing for an hour from the pickup.
  const picked = new Date(now).toISOString();
  put(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: picked, who: 'claude', text: 'Checking the calls.' }) + '\n');
  await until(() => waits()[0].picked === picked, 'picked up');
  advance(59);
  await tick();
  assert.equal(wakes().length, 3, 'picked up: quiet for the hour');
  advance(1);
  await until(() => wakes().length === 4, 'still open an hour after the pickup');
  assert.deepEqual(wakes()[3], { added: [], again: [again] });
  await tick();
  await tick();
  assert.equal(wakes().length, 4, 'one wake per due time');
});
