import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { until } from '../shared/test-helpers.mjs';

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
  const advance = (minutes) => { now += minutes * 60000; fs.writeFileSync(clockFile, String(now)); };
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
    fs.writeFileSync(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: progress, kind: 'status', text: 'Running tests' }) + '\n');
    await until(() => !read(stateFile, {})['t/A1'], 'progress clears the silent spell');
    advance(31);
    await until(() => read(stateFile, {})['t/A1'] === progress, 'the next silent spell is recorded');
    assert.deepEqual(stalledEvents().map((e) => e.data), [{ key: 't/A1', silentSince: started }, { key: 't/A1', silentSince: progress }]);

    fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started, done: new Date(now).toISOString() }));
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
  const agentFile = path.join(dataDir, 'agents', 'A0.json');
  const usageFile = path.join(dir, '.claude', 'kickflip', 'usage.json');
  const now = Date.parse('2026-11-02T16:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  const boardJSON = (on) => fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't', auto_pull: on }));
  boardJSON(false);
  const wave = { items: [
    { id: 'A0', title: 'Running', status: 'building' },
    { id: 'A1', title: 'Held', status: 'planned', held: true },
    { id: 'A2', title: 'Blocked', status: 'waiting', deps: ['A0'] },
    { id: 'A3', title: 'Asking', status: 'planned' },
    { id: 'A4', title: 'Next', status: 'planned' },
    { id: 'A5', title: 'Bumped', status: 'planned' },
    { id: 'A6', title: 'Last', status: 'planned' },
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
  const thread = (id) => (fs.existsSync(path.join(dataDir, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(dataDir, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).text) : []);
  const ask = (id, key) => { owner.items.push(question(id, key)); fs.writeFileSync(ownerFile, JSON.stringify(owner)); };
  const setStatus = (id, status) => { wave.items.find((it) => it.id === id).status = status; fs.writeFileSync(waveFile, JSON.stringify(wave)); };
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

    fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started: iso(now - 60000), done: iso(now) }));
    await until(() => pulls().length === 1, 'the idle board pulls in a card');
    assert.deepEqual(pulls(), ['t/A5']);
    assert.deepEqual(thread('A5'), ['Pulled in: the board was idle.']);
    await tick();
    await stop();
    await start();
    await tick();
    fs.rmSync(path.join(dataDir, 'pulled.json'));
    await stop();
    await start();
    await tick();
    assert.deepEqual(pulls(), ['t/A5']);

    setStatus('A0', 'checking');
    ask('q5', 't/A5');
    await tick();
    assert.deepEqual(pulls(), ['t/A5']);
    setStatus('A0', 'done');
    await until(() => pulls().length === 2, 'the next card is pulled once the board is idle again');
    assert.deepEqual(pulls(), ['t/A5', 't/A6']);

    fs.writeFileSync(usageFile, JSON.stringify({ claude: { at: iso(now), five_hour: { used_percentage: 95, resets_at: iso(now + 3600000) }, seven_day: { used_percentage: 40, resets_at: iso(now + 86400000) } } }));
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
