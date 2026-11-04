import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { until } from '../shared/test-helpers.mjs';

// Writes a file the running server may be reading the way the board does (write aside, then rename), so the server
// never reads it half-written.
const put = (file, text) => { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); };

test('automatic builder check-ins run without a browser, once per silent spell across a restart, and stop on done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-stalled-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const stateFile = path.join(dataDir, 'builder-stalled.json');
  const agentFile = path.join(dataDir, 'agents', 'A1.json');
  let now = Date.parse('2026-10-30T10:00:00Z');
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', status: 'building', title: 'One' }] }));
  const started = new Date(now - 29 * 60000).toISOString();
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
  const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const stalledEvents = () => {
    const text = fs.existsSync(path.join(dataDir, 'events.jsonl')) ? fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8') : '';
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'builder-stalled');
  };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  const advance = (minutes) => { now += minutes * 60000; put(clockFile, String(now)); };
  try {
    await start();
    await tick();
    assert.equal(stalledEvents().length, 0);
    advance(2);
    await until(() => read(stateFile, {})['t/A1'] === started, 'the initial silent spell is recorded');
    assert.deepEqual(stalledEvents().map((e) => e.data), [{ key: 't/A1', silentSince: started }]);
    await stop();
    await start();
    await tick();
    assert.equal(stalledEvents().length, 1);
    await stop();
    fs.rmSync(stateFile);
    await start();
    await until(() => read(stateFile, {})['t/A1'] === started, 'the silent spell is restored after restart');
    assert.equal(stalledEvents().length, 1);

    const progress = new Date(now).toISOString();
    put(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: progress, kind: 'status', text: 'Running tests' }) + '\n');
    await until(() => !read(stateFile, {})['t/A1'], 'progress clears the silent spell');
    advance(31);
    await until(() => read(stateFile, {})['t/A1'] === progress, 'the next silent spell is recorded');
    assert.deepEqual(stalledEvents().map((e) => e.data), [{ key: 't/A1', silentSince: started }, { key: 't/A1', silentSince: progress }]);

    put(agentFile, JSON.stringify({ kind: 'codex', started, done: new Date(now).toISOString() }));
    await until(() => !read(stateFile, {})['t/A1'], 'finishing the builder clears the silent spell');
    advance(60);
    await tick();
    assert.equal(stalledEvents().length, 2);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a held card resumes itself within a minute of its pick-up time, once per time across a restart, announcing card-unblocked unless a dep is unfinished', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-up-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'wave.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  let now = Date.parse('2026-11-04T16:30:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const at = iso(now + 30 * 60000);
  let worker;
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(waveFile, JSON.stringify({ items: [
    { id: 'A0', title: 'Dep', status: 'building' },
    { id: 'A1', title: 'Timed', status: 'planned', held: true, pick_up_at: at, held_at: iso(now - 60000) },
    { id: 'A2', title: 'Blocked', status: 'waiting', deps: ['A0'], held: true, pick_up_at: at, held_at: iso(now - 60000) },
    { id: 'A3', title: 'Tapped', status: 'planned' },
    { id: 'A4', title: 'Forever', status: 'planned', held: true, held_at: iso(now - 60000) },
    { id: 'A5', title: 'Cut short', status: 'planned', held: true, pick_up_at: at, held_at: iso(now - 60000) },
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
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
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
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
test('with auto implement on the board sends card-pull for the top pullable Todo cards at start and on each change, filling free slots up to Maximum parallel implementers, once each across a restart, and never while paused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-pull-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'wave.json');
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
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_pull: true, max_implementers: 2 }));
  const wave = { items: [
    { id: 'A0', title: 'Running', status: 'building' },
    { id: 'A1', title: 'Held', status: 'planned', state: 'ready', held: true },
    { id: 'A2', title: 'Blocked', status: 'waiting', state: 'ready', deps: ['A0'] },
    { id: 'A3', title: 'Asking', status: 'planned', state: 'ready' },
    { id: 'A4', title: 'Next', status: 'planned', state: 'ready' },
    { id: 'A5', title: 'Bumped', status: 'planned', state: 'ready' },
    { id: 'A6', title: 'Last', status: 'planned', state: 'ready' },
    { id: 'A7', title: 'Spare', status: 'planned', state: 'ready' },
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
  const pulls = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'card-pull').map((e) => e.data.key);
  const thread = (id) => (fs.existsSync(path.join(dataDir, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(dataDir, 'threads', `t__${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
  const ask = (id, key) => { owner.items.push(question(id, key)); put(ownerFile, JSON.stringify(owner)); };
  const setStatus = (id, status) => { wave.items.find((it) => it.id === id).status = status; put(waveFile, JSON.stringify(wave)); };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
    // At start the running build takes one of the two slots; the top pullable card takes the other.
    await start();
    await until(() => pulls().length === 1 && thread('A5').length === 1, 'the board pulls in a card at start');
    assert.deepEqual(pulls(), ['t/A5']);
    assert.deepEqual(thread('A5'), ['Pulled in: an implementer slot was free.']);
    await until(() => fs.existsSync(pulledFile) && JSON.parse(fs.readFileSync(pulledFile, 'utf8')).keys.join() === 't/A5', 'the pull is marked');
    await stop();
    fs.rmSync(pulledFile);
    await start();
    await tick();
    assert.deepEqual(pulls(), ['t/A5'], 'the event log covers a lost marker');

    // The build finishing frees its slot at once, with A5 still waiting to start.
    put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
    await until(() => pulls().length === 2, 'a freed slot is filled on the change');
    assert.deepEqual(pulls(), ['t/A5', 't/A7']);
    // The event comes first and the marker after; stopping between them loses the pull, since the mocked clock gives the
    // event and the marker one timestamp and the log only covers events after the marker.
    await until(() => JSON.parse(fs.readFileSync(pulledFile, 'utf8')).keys.join() === 't/A5,t/A7', 'the second pull is marked');

    // Changed while the server is down: Orchestrator review takes A0's slot back, so A5 stopping being pullable frees
    // none.
    await stop();
    setStatus('A0', 'checking');
    ask('q5', 't/A5');
    await start();
    await tick();
    assert.deepEqual(pulls(), ['t/A5', 't/A7']);
    setStatus('A0', 'done');
    await until(() => pulls().length === 3, 'the review ending frees a slot');
    assert.deepEqual(pulls(), ['t/A5', 't/A7', 't/A6']);

    put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
    ask('q7', 't/A7');
    await tick();
    await tick();
    assert.deepEqual(pulls(), ['t/A5', 't/A7', 't/A6']);
    fs.rmSync(usageFile);
    await until(() => pulls().length === 4, 'the pull waits for the pause to end');
    assert.deepEqual(pulls(), ['t/A5', 't/A7', 't/A6', 't/A4']);
    assert.deepEqual(['A1', 'A2', 'A3', 'F1'].map(thread), [[], [], [], []]);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-0150-queued-sits-at-the-top-of-todo.md
test('a tapped card whose blockers are done waits in Queued while In Progress is at Maximum parallel implementers, and the server starts it once a slot frees', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cap-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const waveFile = path.join(dataDir, 'wave.json');
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const setup = path.join(dir, 'setup.mjs');
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', max_implementers: 1 }));
  put(waveFile, JSON.stringify({ items: [
    { id: 'A0', title: 'Running', status: 'building' },
    { id: 'A9', title: 'Blocker', status: 'done' },
    { id: 'Q1', title: 'Tapped', deps: ['A9'], queued_at: iso(now - 60000) },
  ] }));
  put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000) }));
  fs.writeFileSync(setup, "import http from 'node:http'; http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };");
  const queuedAt = () => JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === 'Q1').queued_at;
  try {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], { env: { ...process.env, HOME: dir } });
    await new Promise((resolve, reject) => { worker.stdout.once('data', resolve); worker.once('exit', (code) => reject(new Error(`Server exited ${code}`))); });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(queuedAt(), iso(now - 60000), 'the running build holds the only slot');
    // The start is tried once the build finishes; with no repo here it is refused, which clears the queue.
    put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
    await until(() => queuedAt() === undefined, 'the queued card starts once a slot frees');
  } finally {
    if (worker?.exitCode === null) { const exited = new Promise((resolve) => worker.once('exit', resolve)); worker.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
test('with auto-triage on, a board sends overnight-triage once a night from the middle of quiet hours, when two cards wait on your answers and nothing builds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-triage-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'wave.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  let now = Date.parse('2026-11-02T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardJSON = (on) => put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_pull: on, auto_triage: on, max_implementers: 1 }));
  boardJSON(false);
  const wave = { items: [
    { id: 'A0', title: 'Running', status: 'building' },
    { id: 'A1', title: 'One', status: 'planned', state: 'ready' },
    { id: 'A2', title: 'Two', status: 'planned' },
    { id: 'A3', title: 'Three', status: 'planned' },
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
  const pulls = () => logged('card-pull').map((e) => e.data.key);
  const reply = (id) => { fs.mkdirSync(path.join(dataDir, 'replies'), { recursive: true }); put(path.join(dataDir, 'replies', `${id}.html`), '<p>Triaged.</p>'); };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, TZ: 'UTC', BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
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

    agent(false);
    setClock(Date.parse('2026-11-03T02:59:00Z'));
    await tick();
    assert.deepEqual(triages(), [], 'never before the middle of quiet hours');
    setClock(Date.parse('2026-11-03T03:00:00Z'));
    await tick();
    await tick();
    assert.deepEqual(triages(), [], 'a running builder holds it');

    agent(true);
    await until(() => triages().length === 1, 'the idle board triages overnight');
    const [first] = triages();
    assert.deepEqual({ ...first.data, cards: first.data.cards.sort() }, { date: '2026-11-03', topic: 'overnight-triage-2026-11-03', cards: ['t/A2', 't/A3'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).topics, [{ id: 'overnight-triage-2026-11-03', title: 'Overnight triage 2026-11-03' }]);
    // The triage's own changes wait for its reply.
    wave.items[2].title = 'Two, merged with a duplicate';
    writeWave();
    const markerFile = path.join(dataDir, 'triaged.json');
    await until(() => fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8').includes('merged with a duplicate'), 'the server saw the triage\'s own change');
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

    wave.items[1].title = 'One, renamed';
    put(usageFile, JSON.stringify({ claude: { at: '2026-11-06T03:00:00.000Z', five_hour: { used_percentage: 95, resets_at: '2026-11-06T09:00:00.000Z' }, seven_day: { used_percentage: 40, resets_at: '2026-11-09T00:00:00.000Z' } } }));
    setClock(Date.parse('2026-11-06T03:00:00Z'));
    writeWave();
    await tick();
    await tick();
    assert.equal(triages().length, 2, 'nothing while paused');
    fs.rmSync(usageFile);
    await until(() => triages().length === 3, 'the triage goes once the pause lifts');
    assert.equal(triages()[2].data.date, '2026-11-06');
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md
test('an idle board with auto-pull on and nothing to pull sends card-plan for its top unready Todo card, one at a time, never while one is planned or paused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-plan-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const waveFile = path.join(dataDir, 'wave.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const ownerFile = path.join(dataDir, 'owner.json');
  const agentFile = path.join(dataDir, 'agents', 'B3.json');
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  const now = Date.parse('2026-11-03T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_pull: true }));
  const wave = { items: [
    { id: 'B1', title: 'Asking', status: 'planned', state: 'grilling' },
    { id: 'B2', title: 'Also unready', status: 'planned', state: 'prototyping' },
    { id: 'B3', title: 'Left grilling', status: 'planned', state: 'grilling' },
  ] };
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
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
    await start();
    await tick();
    assert.deepEqual(logged('card-plan'), []);
    fs.rmSync(usageFile);
    await until(() => logged('card-plan').length === 1 && thread('B3').length === 1, 'the idle board asks for a plan');
    assert.deepEqual(logged('card-plan'), ['t/B3']);
    assert.deepEqual(thread('B3'), ['Asked for a grill or prototype: nothing in Todo was ready to build.']);
    await stop();
    await start();
    await tick();
    await tick();
    assert.deepEqual(logged('card-plan'), ['t/B3']);

    // The session starts a prototype: nothing else is planned while it runs, and B3 is planned no more once it posts a question.
    put(agentFile, JSON.stringify({ kind: 'prototype', started: iso(now) }));
    await tick();
    await tick();
    assert.deepEqual(logged('card-plan'), ['t/B3']);
    put(ownerFile, JSON.stringify({ topics: [], items: [question('q1', 't/B1'), question('q2', 't/B3')] }));
    put(agentFile, JSON.stringify({ kind: 'prototype', started: iso(now), done: iso(now) }));
    await until(() => logged('card-plan').length === 2, 'the next unready card is planned');
    assert.deepEqual(logged('card-plan'), ['t/B3', 't/B2']);

    // A ready card is pulled, not planned.
    wave.items.push({ id: 'B4', title: 'Ready', status: 'planned', state: 'ready' });
    put(waveFile, JSON.stringify(wave));
    await until(() => logged('card-pull').length === 1, 'a ready card is pulled');
    assert.deepEqual(logged('card-pull'), ['t/B4']);
    assert.deepEqual(logged('card-plan'), ['t/B3', 't/B2']);
    assert.deepEqual(thread('B1'), []);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test('an idle board with auto review on sends pr-review for one incoming PR at a time, asked first, never while a builder runs or usage is paused', async () => {
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
  const boardJSON = (on) => put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_review: on }));
  boardJSON(false);
  fs.writeFileSync(path.join(dataDir, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', status: 'building' }] }));
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
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
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
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test("a question's prototype request still waiting 30 minutes on with no prototype agent running is raised as prototype-overdue, once across a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-overdue-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  let now = Date.parse('2026-10-30T10:00:00Z');
  let worker;
  fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
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
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
  try {
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
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
test('a card that comes to wait on the orchestrator wakes the session once, and pushes the owner once 30 minutes on, across a restart', async () => {
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
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't' }));
  const handedAt = new Date(now - 5 * 60000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', status: 'building', status_at: handedAt }, { id: 'A2', title: 'Two' }] }));
  fs.writeFileSync(path.join(dataDir, 'agents', 'A1.json'), JSON.stringify({ kind: 'claude', started: new Date(now - 60 * 60000).toISOString(), calls: [{ at: handedAt, text: 'Kept the old name' }] }));
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
  const pushes = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const flag = (call, name) => call[call.indexOf(`--${name}`) + 1];
  const waits = () => { try { return JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits; } catch { return null; } };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile, KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
  try {
    await start();
    await until(() => waits() !== null, 'the first wait check');
    assert.deepEqual(waits(), [], 'a live builder owns the card');
    // builder done hands it back with its calls: no event of its own, yet the list wakes the session.
    put(path.join(dataDir, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', status: 'checking', status_at: handedAt, next: "Verify the builder's judgment calls" }, { id: 'A2', title: 'Two' }] }));
    await until(() => wakes().length === 1, 'the hand-back wakes the session');
    assert.deepEqual(wakes(), [{ added: ['t/A1'] }]);
    assert.deepEqual(waits().map((w) => [w.key, w.kind, w.since, w.picked]), [['t/A1', 'calls', handedAt, null]]);
    assert.equal(pushes().length, 0, 'five minutes in, no push');
    await tick();
    assert.equal(wakes().length, 1, 'once');
    now += 26 * 60000;
    put(clockFile, String(now));
    await until(() => pushes().length === 1, 'pushed 30 minutes on');
    assert.equal(flag(pushes()[0], 'title'), 'A1 waits on the orchestrator');
    assert.equal(flag(pushes()[0], 'body'), "One: Verify the builder's judgment calls");
    assert.equal(flag(pushes()[0], 'tag'), 'wait-t/A1');
    await until(() => waits()[0].pushed === true, 'the push is kept');
    await stop();
    await start();
    await tick();
    await tick();
    assert.equal(wakes().length, 1, 'no second wake after a restart');
    assert.equal(pushes().length, 1, 'no second push after a restart');
    // The session's thread line picks it up: it stays on the list, picked, and wakes nothing.
    const picked = new Date(now).toISOString();
    put(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: picked, who: 'claude', text: 'Checking the calls.' }) + '\n');
    await until(() => waits()[0].picked === picked, 'picked up');
    assert.equal(wakes().length, 1);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
