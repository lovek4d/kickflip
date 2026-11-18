// docs/adr/2026-11-17-2330-an-idle-orchestrator-restarts-fresh-once-its-prompt-cache-lapses.md
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalHome = process.env.HOME;
const home = fs.realpathSync(tempDir('fresh-start-'));
process.env.HOME = home;
after(() => { process.env.HOME = originalHome; });
const { freshStartDue, freshIdleSessions, hubArgv, freshFor, CACHE_TTL } = await import('./sessions.mjs');

const NOW = new Date('2026-11-17T23:30:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const web = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const wait = (kind, since, picked = null) => ({ key: 'b/T-1', kind, since, picked });
const due = (over = {}) => freshStartDue({ listening: true, busy: false, lastTurn: NOW.getTime() - CACHE_TTL - MIN, waits: [], entry: null, session: 's1', now: NOW.getTime(), ...over });

test('a listening, idle session whose last turn is past the cache lapse starts fresh; it says how long it was idle', () => {
  assert.equal(due(), 61);
  assert.equal(due({ lastTurn: NOW.getTime() - CACHE_TTL + MIN }), null, 'its cache has not lapsed');
  assert.equal(due({ lastTurn: null }), null, 'no transcript to read');
  assert.equal(due({ listening: false }), null, 'a board not listening goes through the resume path');
  assert.equal(due({ busy: true }), null);
});

test('a wait unpicked past a minute, any picked wait and a build waiting on verify hold it; a fresh wait and a limbo wait do not', () => {
  assert.equal(due({ waits: [wait('reply', ago(30_000))] }), 61, 'a wait under a minute old is for the new session to pick up');
  assert.equal(due({ waits: [wait('reply', ago(2 * MIN))] }), null);
  assert.equal(due({ waits: [wait('staging', ago(3 * 60 * MIN), ago(2 * 60 * MIN))] }), null, 'picked but unfinished');
  assert.equal(due({ waits: [wait('calls', ago(10_000))] }), null, 'a builder finished and waiting on verify');
  assert.equal(due({ waits: [wait('limbo', ago(5 * 60 * MIN))] }), 61);
});

test('one fresh start per lapse: the session recorded is skipped until it takes a turn 15 minutes past the start', () => {
  const at = ago(CACHE_TTL + 5 * MIN);
  assert.equal(due({ entry: { session: 's1', at }, lastTurn: Date.parse(at) + 2 * MIN }), null, 'only its join since the start');
  assert.equal(due({ entry: { session: 's1', at }, lastTurn: Date.parse(at) - 10 * MIN }), null, 'a start that failed is not retried');
  assert.equal(due({ entry: { session: 's1', at: ago(5 * 60 * MIN) }, lastTurn: NOW.getTime() - CACHE_TTL - MIN }), 61, 'it worked since, and lapsed again');
  assert.equal(due({ entry: { session: 'other', at } }), 61);
});

function setup() {
  fs.rmSync(web(), { recursive: true, force: true });
  const site = (route, extra = {}) => ({ dir: path.join(home, 'sites', route), port: 1, cmd: [process.execPath, path.join(SKILL, 'board', 'server.mjs')], owner: { session: `s-${route}`, repo: home }, ...extra });
  return { sites: { orch: site('orch', { hub: true }), shop: site('shop') } };
}

test('the check starts each due board fresh once, audits it, and starts it again only after another lapse', async () => {
  const manifest = setup();
  const started = [];
  let n = 0;
  const run = (now, over = {}) => freshIdleSessions({
    manifest, now, running: new Map([['s-orch', { status: 'idle' }], ['s-shop', { status: 'idle' }]]),
    listening: () => true, lastTurn: (b) => (b.route === 'orch' ? NOW.getTime() - 2 * CACHE_TTL : NOW.getTime()), waitsOf: () => [], paused: () => false,
    fresh: async (b) => { started.push(b.route); return { session: `fresh-${++n}` }; }, ...over,
  });
  assert.deepEqual(await run(NOW), { started: ['orch'], failed: [] });
  assert.deepEqual(read(web('fresh-state.json')), { orch: { session: 'fresh-1', at: NOW.toISOString() } });
  const audit = fs.readFileSync(path.join(manifest.sites.orch.dir, 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(audit.call, 'fresh');
  assert.equal(audit.result, 'started fresh');
  assert.match(audit.reason, /idle 120 minutes, its prompt cache lapsed/i);

  // The manifest now names the fresh session, whose only turn is its join.
  manifest.sites.orch.owner.session = 'fresh-1';
  const later = new Date(NOW.getTime() + 2 * CACHE_TTL);
  const joined = (b) => (b.route === 'orch' ? NOW.getTime() + 2 * MIN : later.getTime());
  assert.deepEqual(await run(later, { lastTurn: joined }), { started: [], failed: [] });
  assert.deepEqual(read(web('fresh-state.json')), { orch: { session: 'fresh-1', at: NOW.toISOString() } });

  // Once it has worked past its join and lapsed again, it starts fresh again.
  const worked = (b) => (b.route === 'orch' ? NOW.getTime() + 30 * MIN : later.getTime());
  assert.deepEqual(await run(later, { lastTurn: worked }), { started: ['orch'], failed: [] });
  assert.deepEqual(started, ['orch', 'orch']);
});

test('a start that fails is recorded on the old session and audited, and not retried within that lapse', async () => {
  const manifest = setup();
  const run = () => freshIdleSessions({
    manifest, now: NOW, running: new Map([['s-orch', { status: 'idle' }]]), listening: (b) => b.route === 'orch',
    lastTurn: () => NOW.getTime() - 2 * CACHE_TTL, waitsOf: () => [], paused: () => false,
    fresh: async () => { throw Object.assign(new Error('tmux new-session failed'), { reason: 'failed' }); },
  });
  const first = await run();
  assert.deepEqual(first.started, []);
  assert.match(first.failed[0], /^orch: could not start its session fresh \(tmux new-session failed\)/);
  assert.deepEqual(read(web('fresh-state.json')).orch.session, 's-orch');
  assert.deepEqual(await run(), { started: [], failed: [] });
});

test('the join names the session the hub started fresh, for its brief', () => {
  setup();
  fs.mkdirSync(web(), { recursive: true });
  fs.writeFileSync(web('fresh-state.json'), JSON.stringify({ orch: { session: 'fresh-1', at: NOW.toISOString() } }));
  assert.equal(freshFor('orch', 'fresh-1'), true);
  assert.equal(freshFor('orch', 's-orch'), false);
  assert.equal(freshFor('shop', 'fresh-1'), false);
});

test("the hub board's fresh session starts under the id the owner moves to, and joins without --hub", () => {
  const argv = hubArgv({ route: 'orch', title: 'Orch', id: 'u-1', fresh: true });
  assert.deepEqual(argv.slice(0, 2), ['--session-id', 'u-1']);
  assert.ok(!argv.includes('--resume'));
  assert.match(argv.at(-1), /^\/kickflip board 'Orch'\n/);
});

test("the hub board's fresh start stops its session, waits out its tmux session, moves the owner and its watcher cursor to the new id, and moves them back when tmux refuses", async () => {
  const { freshHubSession } = await import('./sessions.mjs');
  const manifest = setup();
  manifest.sites.orch.watch = ['data/events.jsonl'];
  fs.mkdirSync(path.join(manifest.sites.orch.dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(manifest.sites.orch.dir, 'data', 'events.jsonl'), '');
  fs.writeFileSync(path.join(manifest.sites.orch.dir, 'data', '.watch-cursor-s-orch.json'), JSON.stringify({ 'data/events.jsonl': 7 }));
  fs.mkdirSync(web(), { recursive: true });
  fs.writeFileSync(web('manifest.json'), JSON.stringify(manifest));
  const attempt = async (newStatus) => {
    const steps = [];
    let running = new Map([['s-orch', { pid: 1, sessionId: 's-orch', kind: 'fg' }]]);
    let open = true;
    const tmux = (argv) => {
      steps.push(argv[0] === 'new-session' ? argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2) : argv[0]);
      if (argv[0] === 'has-session') { const was = open; open = false; return { status: was ? 0 : 1, stdout: '', stderr: '' }; }
      return { status: argv[0] === 'new-session' ? newStatus : 0, stdout: '', stderr: newStatus ? 'no server' : '' };
    };
    const owner = () => read(web('manifest.json')).sites.orch.owner.session;
    try {
      const r = await freshHubSession('orch', { live: () => running, stop: async () => { steps.push('stop'); running = new Map(); }, tmux, sleep: async () => {}, limit: 5, id: 'u-new' });
      return { steps, r, owner: owner() };
    } catch (e) { return { steps, error: e.message, owner: owner() }; }
  };
  const ok = await attempt(0);
  assert.deepEqual(ok.steps, ['stop', 'has-session', 'has-session', ['--session-id', 'u-new']]);
  assert.deepEqual([ok.r.session, ok.r.previous, ok.owner], ['u-new', 's-orch', 'u-new']);
  assert.deepEqual(read(path.join(manifest.sites.orch.dir, 'data', '.watch-cursor-u-new.json')), { 'data/events.jsonl': 7 });

  manifest.sites.orch.owner.session = 's-orch';
  fs.writeFileSync(web('manifest.json'), JSON.stringify(manifest));
  const refused = await attempt(1);
  assert.match(refused.error, /tmux new-session failed/);
  assert.equal(refused.owner, 's-orch');
});

test("a session's last turn is its transcript's last write, under its folder's name in Claude Code's projects", async () => {
  const { lastTurn } = await import('./session-activity.mjs');
  const folder = path.join(home, 'my.repo');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(home, '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'), 'abc-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  fs.utimesSync(file, NOW, NOW);
  assert.equal(lastTurn(folder, 'abc-1', { home }), NOW.getTime());
  assert.equal(lastTurn(folder, 'missing', { home }), null);
  assert.equal(lastTurn(folder, '../x', { home }), null);
});
