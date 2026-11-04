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

test('an idle board with auto-pull on sends card-pull for its top pullable Todo card, one at a time across a restart, and never while paused', async () => {
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
  const boardJSON = (on) => put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_pull: on }));
  boardJSON(false);
  const wave = { items: [
    { id: 'A0', title: 'Running', status: 'building' },
    { id: 'A1', title: 'Held', status: 'planned', state: 'ready', held: true },
    { id: 'A2', title: 'Blocked', status: 'waiting', state: 'ready', deps: ['A0'] },
    { id: 'A3', title: 'Asking', status: 'planned', state: 'ready' },
    { id: 'A4', title: 'Next', status: 'planned', state: 'ready' },
    { id: 'A5', title: 'Bumped', status: 'planned', state: 'ready' },
    { id: 'A6', title: 'Last', status: 'planned', state: 'ready' },
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
    await start();
    await tick();
    boardJSON(true);
    await tick();
    assert.deepEqual(pulls(), []);

    put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
    await until(() => pulls().length === 1 && thread('A5').length === 1, 'the idle board pulls in a card');
    assert.deepEqual(pulls(), ['t/A5']);
    assert.deepEqual(thread('A5'), ['Pulled in: the board was idle.']);
    await until(() => fs.existsSync(pulledFile) && JSON.parse(fs.readFileSync(pulledFile, 'utf8')).key === 't/A5', 'the pull is marked');
    await stop();
    await start();
    await tick();
    fs.rmSync(pulledFile);
    await stop();
    await start();
    await tick();
    assert.deepEqual(pulls(), ['t/A5']);

    // Changed while the server is down: a check reads wave.json before owner.json, so one landing between the two
    // writes would see A0 not yet checking and A5 already asked, and pull A6.
    await stop();
    setStatus('A0', 'checking');
    ask('q5', 't/A5');
    await start();
    await tick();
    assert.deepEqual(pulls(), ['t/A5']);
    setStatus('A0', 'done');
    await until(() => pulls().length === 2, 'the next card is pulled once the board is idle again');
    assert.deepEqual(pulls(), ['t/A5', 't/A6']);

    put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
    ask('q6', 't/A6');
    await tick();
    await tick();
    assert.deepEqual(pulls(), ['t/A5', 't/A6']);
    fs.rmSync(usageFile);
    await until(() => pulls().length === 3, 'the pull waits for the pause to end');
    assert.deepEqual(pulls(), ['t/A5', 't/A6', 't/A4']);
    assert.deepEqual(['A1', 'A2', 'A3', 'F1'].map(thread), [[], [], [], []]);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-03-1551-an-idle-board-triages-its-todo-once-a-day.md
test('an idle board with auto-triage on sends todo-triage under its dated topic before any pull, at most once a day and only when Todo changed', async () => {
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
  const day = 86400000;
  let now = Date.parse('2026-11-02T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardJSON = (on) => put(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_pull: on, auto_triage: on }));
  boardJSON(false);
  const wave = { items: [
    { id: 'A0', title: 'Running', status: 'building' },
    { id: 'A1', title: 'One', status: 'planned', state: 'ready' },
    { id: 'A2', title: 'Two', status: 'planned', state: 'ready' },
  ] };
  const writeWave = () => put(waveFile, JSON.stringify(wave));
  writeWave();
  const agent = (done) => put(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), ...(done ? { done: iso(now) } : {}) }));
  agent(true);
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [], items: [] }));
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
  const triages = () => logged('todo-triage');
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
    await tick();
    assert.deepEqual(triages(), [], 'off by default');

    agent(false);
    boardJSON(true);
    await tick();
    assert.deepEqual([triages(), pulls()], [[], []], 'a running builder keeps the board from being idle');

    agent(true);
    await until(() => triages().length === 1, 'the idle board triages its Todo');
    const [first] = triages();
    assert.deepEqual(first.data, { date: '2026-11-02', topic: 'todo-triage-2026-11-02' });
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).topics, [{ id: 'todo-triage-2026-11-02', title: 'Todo triage 2026-11-02' }]);
    // The triage's own changes to Todo, and the idle pull, wait for its reply.
    wave.items[2].title = 'Two, merged with a duplicate';
    writeWave();
    await tick();
    await tick();
    assert.deepEqual([triages().length, pulls()], [1, []]);

    reply(first.id);
    await until(() => pulls().length === 1, 'the pull follows the finished triage');
    await stop();
    await start();
    await tick();
    assert.equal(triages().length, 1, 'once that day, across a restart');

    setClock(now + day);
    await tick();
    await tick();
    assert.equal(triages().length, 1, 'a new day with Todo unchanged since the triage sends none');

    put(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + day) } } }));
    wave.items.push({ id: 'A3', title: 'Three', status: 'planned' });
    writeWave();
    await tick();
    await tick();
    assert.equal(triages().length, 1, 'nothing while paused');
    fs.rmSync(usageFile);
    await until(() => triages().length === 2, 'a changed Todo on a later day triages again');
    assert.deepEqual(triages()[1].data, { date: '2026-11-03', topic: 'todo-triage-2026-11-03' });
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
