import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-')));
process.env.HOME = home;
const { checkSessions, RESUME_AFTER, COMEBACK_WAIT, BG_SETTINGS } = await import('./sessions.mjs');
const { WAIT_MS } = await import('./prompts.mjs');

const web = (...p) => path.join(home, '.claude', 'web-ts', ...p);
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = () => read(web('manifest.json'));
const boardCmd = (dir) => [process.execPath, path.join(SKILL, 'board', 'server.mjs'), dir];
const repo = path.join(home, 'repo');
const otherRepo = path.join(home, 'other');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(otherRepo, { recursive: true });

const fakeLog = path.join(home, 'claude-calls.jsonl');
const fakeClaude = path.join(home, 'bin', 'claude');
const agentsFile = path.join(home, 'agents.json');
const copyNext = path.join(home, 'copy-next');
const foregroundExit = path.join(home, 'foreground-exit');
process.env.WEB_TS_CLAUDE = fakeClaude;
write(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv[0] === 'agents') { let list = []; try { list = JSON.parse(fs.readFileSync(${JSON.stringify(agentsFile)}, 'utf8')); } catch {} console.log(JSON.stringify(list)); process.exit(0); }
if (!argv.includes('--bg')) {
  fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv, cwd: process.cwd(), isolation: process.env.CLAUDE_BG_ISOLATION ?? null, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
  console.log('foreground stdin: ' + fs.readFileSync(0, 'utf8'));
  console.error('foreground stderr');
  process.exit(fs.existsSync(${JSON.stringify(foregroundExit)}) ? Number(fs.readFileSync(${JSON.stringify(foregroundExit)}, 'utf8')) : 0);
}
const resumed = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
const copy = fs.existsSync(${JSON.stringify(copyNext)});
if (copy) fs.unlinkSync(${JSON.stringify(copyNext)});
const id = resumed && !copy ? resumed : require('node:crypto').randomUUID();
if (id !== resumed) fs.writeFileSync(${JSON.stringify(path.join(home, '.claude', 'sessions'))} + '/fake-' + id + '.json', JSON.stringify({ pid: spawnSync('true').pid, sessionId: id, jobId: id.slice(0, 8), kind: 'bg' }));
fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv, id, cwd: process.cwd(), isolation: process.env.CLAUDE_BG_ISOLATION, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
const lingering = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });
fs.appendFileSync(${JSON.stringify(fakeLog)} + '.pids', lingering.pid + '\\n');
lingering.unref();
if (resumed && id !== resumed) console.log('note: background session ' + resumed.slice(0, 8) + ' keeps its own saved options, so the flags you passed started a copy as ' + id.slice(0, 8) + '.');
console.log('backgrounded · ' + id.slice(0, 8) + ' · board');
console.log('  claude attach ' + id.slice(0, 8) + '    open in this terminal');
`);
fs.chmodSync(fakeClaude, 0o755);
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
const calls = () => { try { return fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const sleepers = [];
const liveRecord = (sessionId, cwd) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(c);
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(c.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  write(path.join(home, '.claude', 'sessions', `${c.pid}.json`), { pid: c.pid, sessionId, cwd, procStart, kind: 'interactive' });
  return c;
};

const cli = (args, { cwd = repo, input = '' } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(SKILL, 'bin', 'web-ts.mjs'), ...args], {
    cwd, env: { ...process.env, HOME: home, WEB_TS_CLAUDE: fakeClaude, WEB_TS_HUB_PORT: '1', CLAUDECODE: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(input);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

after(() => {
  for (const c of sleepers) c.kill();
  try { for (const pid of fs.readFileSync(fakeLog + '.pids', 'utf8').trim().split('\n')) { try { process.kill(Number(pid)); } catch {} } } catch {}
  fs.rmSync(home, { recursive: true, force: true });
});

test('join records the session and its folder: --repo, else the live session\'s cwd, else the recorded one, else where join ran; a rejoin, or a --force takeover, keeps the label, model and folder it leaves out', async () => {
  json(await cli(['join', 'notes', '--session', 's-notes', '--label', 'Notes']));
  assert.deepEqual(manifest().sites.notes.owner, { ...manifest().sites.notes.owner, session: 's-notes', label: 'Notes', repo });
  json(await cli(['join', 'notes', '--session', 's-notes', '--repo', otherRepo, '--model', 'opus']));
  assert.deepEqual([manifest().sites.notes.owner.repo, manifest().sites.notes.owner.model, manifest().sites.notes.owner.label], [otherRepo, 'opus', 'Notes']);
  liveRecord('s-notes', path.join(repo, 'apps'));
  json(await cli(['join', 'notes', '--session', 's-notes']));
  assert.deepEqual([manifest().sites.notes.owner.repo, manifest().sites.notes.owner.model], [path.join(repo, 'apps'), 'opus']);
  const owner = () => { const o = manifest().sites.notes.owner; return [o.session, o.label, o.model, o.repo]; };
  json(await cli(['join', 'notes', '--session', 's-notes-2', '--force'], { cwd: otherRepo }));
  assert.deepEqual(owner(), ['s-notes-2', 'Notes', 'opus', path.join(repo, 'apps')]);
  json(await cli(['join', 'notes', '--session', 's-notes-2'], { cwd: otherRepo }));
  assert.deepEqual(owner(), ['s-notes-2', 'Notes', 'opus', path.join(repo, 'apps')]);
});

test('start runs claude --bg in the folder, in auto mode with isolation off, and records the new session as the owner', async () => {
  json(await cli(['join', 'shop', '--session', 's-old', '--title', 'Shop', '--repo', repo]));
  const t = Date.now();
  const r = json(await cli(['start', 'shop', '--model', 'opus', '--prompt', 'Pick up INT-9']));
  assert.ok(Date.now() - t < 10_000, 'start returns while what claude --bg left behind still runs');
  const [call] = calls();
  const { id } = call;
  assert.deepEqual(call.argv, ['--bg', '--name', 'Shop', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'opus', '/join-web-ts shop Pick up INT-9']);
  const settings = JSON.parse(BG_SETTINGS);
  assert.deepEqual(Object.keys(settings), ['worktree', 'hooks']);
  assert.deepEqual([settings.worktree, Object.keys(settings.hooks)], [{ bgIsolation: 'none' }, ['PermissionRequest']]);
  const [{ matcher, hooks: [hook, ...more] }] = settings.hooks.PermissionRequest;
  assert.deepEqual([matcher, hook.type, more], ['*', 'command', []]);
  assert.equal(hook.command, `"${process.execPath}" "${path.join(SKILL, 'hub', 'permission-hook.mjs')}"`);
  assert.ok(hook.timeout * 1000 > WAIT_MS, `the hook's timeout ${hook.timeout}s must outlast its wait`);
  assert.deepEqual([call.cwd, call.isolation, call.claudecode], [repo, 'none', null]);
  assert.deepEqual([r.session, r.confirmed, r.repo, r.argv], [id, true, repo, [fakeClaude, ...call.argv]]);
  assert.deepEqual(manifest().sites.shop.owner, { ...manifest().sites.shop.owner, session: id, repo, model: 'opus' });
});

test('start on a route with no site waits in starting until that session joins', async () => {
  const before = calls().length;
  const pending = { title: 'Fresh board', repo: otherRepo, asked_at: new Date().toISOString() };
  const m = manifest();
  m.starting = { ...m.starting, fresh: pending };
  write(web('manifest.json'), m);
  const r = json(await cli(['start', 'fresh', '--repo', otherRepo]));
  const call = calls()[before];
  assert.deepEqual([call.argv.at(-1), call.cwd, call.argv.includes('--model')], ['/join-web-ts fresh', otherRepo, false]);
  assert.deepEqual(manifest().starting.fresh, { ...manifest().starting.fresh, session: r.session, repo: otherRepo });
  assert.deepEqual([manifest().starting.fresh.title, manifest().starting.fresh.asked_at, call.argv[2]], [pending.title, pending.asked_at, pending.title]);
  assert.equal(manifest().sites.fresh, undefined);
  assert.match((await cli(['sessions'])).stdout, new RegExp(`^/fresh  ${r.session}  not live  ${otherRepo}  \\(starting: not joined yet\\)$`, 'm'));
  json(await cli(['join', 'fresh', '--session', r.session], { cwd: otherRepo }));
  assert.deepEqual([manifest().sites.fresh.owner.session, manifest().sites.fresh.owner.repo, manifest().starting], [r.session, otherRepo, undefined]);
});

test('resume runs claude --resume <id> --bg in the recorded folder, and start and resume refuse a live session', async () => {
  const { session } = manifest().sites.shop.owner;
  const before = calls().length;
  const r = json(await cli(['resume', 'shop']));
  const call = calls()[before];
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', session, '--bg', '--name', 'Shop', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'opus']);
  assert.match(call.argv.at(-1), new RegExp(`join shop --session ${session}\``));
  assert.deepEqual([call.cwd, r.session, r.repo], [repo, session, repo]);
  liveRecord(session, repo);
  const refusals = [await cli(['resume', 'shop']), await cli(['start', 'shop'])];
  assert.deepEqual(refusals.map((x) => x.status), [3, 3]);
  assert.match(refusals[0].stderr, /is live \(in a terminal, pid \d+\)/);
  assert.equal(calls().length, before + 1);
  const none = await cli(['resume', 'nowhere']);
  assert.deepEqual([none.status, none.stderr.trim()], [1, 'web-ts: /nowhere has no recorded session']);
});

test('sessions prints one line per board: route, session, live or not, folder', async () => {
  write(path.join(home, 'boards', 'b1', 'board.json'), { title: 'B1' });
  write(path.join(home, 'boards', 'b2', 'board.json'), { title: 'B2' });
  const m = manifest();
  m.sites.b1 = { dir: path.join(home, 'boards', 'b1'), port: 1, cmd: boardCmd(path.join(home, 'boards', 'b1')), owner: { session: 's-b1', repo } };
  m.sites.b2 = { dir: path.join(home, 'boards', 'b2'), port: 2, cmd: boardCmd(path.join(home, 'boards', 'b2')) };
  write(web('manifest.json'), m);
  liveRecord('s-b1', repo);
  assert.deepEqual((await cli(['sessions'])).stdout.trim().split('\n'), [`/b1  s-b1  live (terminal)  ${repo}`, '/b2  no session  not live  no folder']);
  assert.deepEqual(json(await cli(['sessions', '--json']))[1], { route: 'b2', session: null, live: null, repo: null, starting: false });
});

test('resume wakes a background session in place with no flags, and records the id a copy comes back under, keeping its label, model and folder and carrying its watcher cursor', async () => {
  const dir = path.join(home, 'boards', 'audit');
  write(path.join(dir, 'board.json'), { title: 'Audit' });
  const id = crypto.randomUUID();
  const m = manifest();
  m.sites.audit = { dir, port: 3, cmd: boardCmd(dir), title: 'Audit', owner: { session: id, label: 'Audit', model: 'opus', repo, since: '2026-10-30T00:00:00Z' } };
  write(web('manifest.json'), m);
  write(agentsFile, [{ id: id.slice(0, 8), sessionId: id, kind: 'background' }]);
  write(path.join(dir, 'data', `.watch-cursor-${id}.json`), { 'data/events.jsonl': 4 });
  const before = calls().length;
  const r = json(await cli(['resume', 'audit']));
  const call = calls()[before];
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', id, '--bg']);
  assert.match(call.argv.at(-1), new RegExp(`join audit --session ${id}\``));
  assert.deepEqual([r.session, r.previous, r.confirmed, manifest().sites.audit.owner.session], [id, id, true, id]);
  write(copyNext, '');
  const copy = json(await cli(['resume', 'audit']));
  assert.notEqual(copy.session, id);
  assert.deepEqual([copy.previous, copy.confirmed], [id, true]);
  const { owner } = manifest().sites.audit;
  assert.deepEqual([owner.session, owner.label, owner.model, owner.repo], [copy.session, 'Audit', 'opus', repo]);
  assert.deepEqual(read(path.join(dir, 'data', `.watch-cursor-${copy.session}.json`)), { 'data/events.jsonl': 4 });
});

test("the hub wakes a board's session as soon as an event lands while it isn't running, once per outage and never while it is live, falls back after a few minutes for an event it never heard, then pushes once", async () => {
  const boards = {};
  const owners = { quiet: { session: 's-quiet', repo }, busy: { session: 's-busy', repo }, bare: { session: 's-bare' }, lost: { session: 's-lost', repo }, old: { session: 's-old', repo, since: '2026-10-29T00:00:00Z' } };
  const events = (route) => path.join(home, 'hub-boards', route, 'data', 'events.jsonl');
  for (const [route, owner] of Object.entries(owners)) {
    const dir = path.join(home, 'hub-boards', route);
    write(path.join(dir, 'board.json'), { title: route[0].toUpperCase() + route.slice(1) });
    write(events(route), '');
    boards[route] = { dir, port: 1, cmd: boardCmd(dir), owner };
  }
  const t0 = Date.parse('2026-10-29T12:00:00Z');
  const event = (route, min) => fs.appendFileSync(events(route), JSON.stringify({ id: crypto.randomUUID(), ts: new Date(t0 + min * 60_000).toISOString(), kind: 'ask' }) + '\n');
  const lines = (route) => ({ 'data/events.jsonl': fs.readFileSync(events(route), 'utf8').split('\n').filter(Boolean).length });
  event('old', -1);
  const m = { sites: boards };
  const listeningNow = new Set();
  const resumed = [];
  const pushed = [];
  const check = (min) => checkSessions({
    manifest: m, now: new Date(t0 + min * 60_000),
    live: () => new Map([['s-busy', { pid: 1, kind: 'interactive' }]]),
    listening: (b) => listeningNow.has(b.route),
    resume: async (route, mark) => { resumed.push([min, route, mark]); if (route === 'lost') throw new Error('no such session'); },
    push: async (msg, opts) => { pushed.push([min, msg.title, msg.tag, msg.body, opts.kind]); },
  });
  const comeback = COMEBACK_WAIT / 60_000;
  const resumeMin = RESUME_AFTER / 60_000;
  await check(0);
  assert.deepEqual(resumed, []);
  for (const route of ['quiet', 'busy', 'bare', 'lost']) event(route, 0.2);
  assert.deepEqual(await check(0.25), { resumed: ['quiet'], pushed: [], failed: ['lost: could not resume its session (no such session)'] });
  assert.deepEqual(resumed, [[0.25, 'quiet', { 'data/events.jsonl': 0 }], [0.25, 'lost', { 'data/events.jsonl': 0 }]]);
  await check(0.5);
  assert.deepEqual(pushed.map((p) => p.slice(0, 3)), [[0.5, "Lost's session didn't come back", 'resume-lost']]);
  assert.match(pushed[0][3], /couldn't resume it: no such session/);
  event('quiet', 1);
  await check(1.25);
  assert.equal(resumed.length, 2, 'one wake per outage');
  await check(resumeMin - 0.25);
  assert.equal(resumed.length, 2);
  await check(resumeMin);
  assert.deepEqual(resumed.at(-1), [resumeMin, 'old', { 'data/events.jsonl': 1 }]);
  await check(0.25 + comeback - 0.25);
  assert.equal(pushed.length, 1);
  await check(0.25 + comeback);
  assert.deepEqual(pushed.map((p) => p.slice(0, 3)).at(-1), [0.25 + comeback, "Quiet's session didn't come back", 'resume-quiet']);
  assert.deepEqual(pushed.map((p) => p[4]), ['fault', 'fault']);
  listeningNow.add('quiet');
  await check(10);
  assert.equal(read(web('resume-state.json')).quiet, undefined);
  listeningNow.delete('quiet');
  await check(11);
  const mark = lines('quiet');
  event('quiet', 11.1);
  await check(11.25);
  assert.deepEqual(resumed.at(-1), [11.25, 'quiet', mark]);
  assert.ok(resumed.every(([, route]) => route !== 'busy' && route !== 'bare'));
});

test('the wake resumes the session in place with a prompt naming its id, and winds its watcher cursor back to the lines it had when the hub saw it stopped', async () => {
  const dir = path.join(home, 'boards', 'wake');
  const file = path.join(dir, 'data', 'events.jsonl');
  write(path.join(dir, 'board.json'), { title: 'Wake' });
  const line = (n) => JSON.stringify({ id: `w${n}`, ts: new Date().toISOString(), kind: 'ask' }) + '\n';
  write(file, line(1));
  const id = crypto.randomUUID();
  const cursor = path.join(dir, 'data', `.watch-cursor-${id}.json`);
  write(cursor, { 'data/events.jsonl': 1 });
  const m = manifest();
  m.sites.wake = { dir, port: 4, cmd: boardCmd(dir), title: 'Wake', owner: { session: id, label: 'Wake', model: 'opus', repo, since: '2026-10-30T00:00:00Z' } };
  write(web('manifest.json'), m);
  write(agentsFile, [{ id: id.slice(0, 8), sessionId: id, kind: 'background' }]);
  const check = () => checkSessions({ manifest: manifest(), live: () => new Map() });
  assert.deepEqual((await check()).resumed, []);
  fs.appendFileSync(file, line(2));
  write(cursor, { 'data/events.jsonl': 2 });
  const before = calls().length;
  assert.deepEqual((await check()).resumed, ['wake']);
  const [call] = calls().slice(before);
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', id, '--bg']);
  assert.match(call.argv.at(-1), new RegExp(`join wake --session ${id}\``));
  assert.deepEqual([read(cursor), manifest().sites.wake.owner.session], [{ 'data/events.jsonl': 1 }, id]);
  assert.deepEqual((await check()).resumed, []);
});

test('the wake gives a session with no watcher cursor the mark as its cursor, for a watched file named __proto__', async () => {
  const dir = path.join(home, 'boards', 'proto-watch');
  const file = path.join(dir, '__proto__');
  write(path.join(dir, 'board.json'), { title: 'Proto watch' });
  const line = (n) => JSON.stringify({ id: `p${n}`, ts: new Date().toISOString(), kind: 'ask' }) + '\n';
  write(file, line(1));
  const id = crypto.randomUUID();
  const cursor = path.join(dir, 'data', `.watch-cursor-${id}.json`);
  const m = fs.existsSync(web('manifest.json')) ? manifest() : { sites: {} };
  m.sites['proto-watch'] = { dir, port: 5, cmd: boardCmd(dir), title: 'Proto watch', watch: ['__proto__'], owner: { session: id, label: 'Proto', model: 'opus', repo, since: '2026-10-30T00:00:00Z' } };
  write(web('manifest.json'), m);
  write(agentsFile, [{ id: id.slice(0, 8), sessionId: id, kind: 'background' }]);
  const check = () => checkSessions({ manifest: manifest(), live: () => new Map() });
  await check();
  fs.appendFileSync(file, line(2));
  assert.ok((await check()).resumed.includes('proto-watch'));
  assert.deepEqual(Object.entries(read(cursor)), [['__proto__', 1]]);
});


test('start, join and resume accept routes named after object properties', async () => {
  for (const [i, route] of ['constructor', 'tostring', 'hasownproperty', 'valueof'].entries()) {
    const started = json(await cli(['start', route, '--repo', repo]));
    assert.equal(manifest().starting[route].session, started.session);
    json(await cli(['join', route, '--session', started.session, '--template', 'board', '--port', String(4650 + i)]));
    assert.equal(Object.hasOwn(manifest().starting || {}, route), false);
    assert.equal(manifest().sites[route].owner.session, started.session);
    const resumed = json(await cli(['resume', route]));
    assert.equal(resumed.session, started.session);
    assert.equal(manifest().sites[route].owner.session, resumed.session);
    assert.match((await cli(['sessions'])).stdout, new RegExp(`^/${route}  ${resumed.session}  not live`, 'm'));
  }
});

test('route lookups ignore inherited site and starting records, including __proto__', async () => {
  const { sessionOf, startingBoards } = await import('./sessions.mjs');
  const { routeRecord } = await import('./routes.mjs');
  for (const route of ['constructor', '__proto__', 'toString']) {
    const owner = { session: 's-own', repo };
    const sites = { [route]: { owner, title: route } };
    const starting = { [route]: { ...owner, title: route, asked_at: new Date().toISOString() } };
    assert.equal(routeRecord({}, route), undefined);
    assert.equal(sessionOf({ sites: {}, starting: {} }, route), null);
    assert.equal(sessionOf({ sites: Object.create(sites), starting: Object.create(starting) }, route), null);
    assert.equal(sessionOf({ sites, starting: {} }, route).session, 's-own');
    assert.equal(sessionOf({ sites: {}, starting }, route).session, 's-own');
    assert.equal(startingBoards({ sites: {}, starting })[0].route, route);
    assert.deepEqual(startingBoards({ sites, starting }), []);
  }
});

test('resume state starts a fresh outage and resumes once for object property routes', async () => {
  const routes = ['constructor', 'tostring', 'hasownproperty', 'valueof', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  const sites = Object.fromEntries(routes.map((route, i) => {
    const dir = path.join(home, 'resume-names', route);
    write(path.join(dir, 'board.json'), { title: route });
    return [route, { dir, port: 4800 + i, cmd: boardCmd(dir), owner: { session: route, repo, since: new Date().toISOString() } }];
  }));
  write(web('resume-state.json'), {});
  const resumed = [];
  const pushed = [];
  const at = Date.now();
  const check = (ms, listening = false) => checkSessions({ manifest: { sites }, now: new Date(at + ms), live: () => new Map(),
    listening: () => listening, resume: async (route) => { resumed.push(route); }, push: async (p) => { pushed.push(p.tag); } });
  assert.deepEqual(await check(0), { resumed: [], pushed: [], failed: [] });
  const state = read(web('resume-state.json'));
  for (const route of routes) {
    assert.equal(state[route].down_since, new Date(at).toISOString());
    write(path.join(sites[route].dir, 'data', 'events.jsonl'), JSON.stringify({ id: route, ts: new Date(at + 1).toISOString(), kind: 'ask', data: {} }) + '\n');
  }
  assert.deepEqual((await check(2)).resumed, routes);
  assert.deepEqual((await check(3)).resumed, []);
  assert.deepEqual((await check(COMEBACK_WAIT + 2)).pushed, routes);
  assert.deepEqual(resumed, routes);
  assert.deepEqual(pushed, routes.map((route) => `resume-${route}`));
  await check(COMEBACK_WAIT + 3, true);
  assert.deepEqual(read(web('resume-state.json')), {});
  const { checkListening } = await import('./boards.mjs');
  write(web('settings.json'), { notifications: { on: false } });
  write(web('deaf-state.json'), {});
  for (const site of Object.values(sites)) delete site.owner.repo;
  const listen = () => checkListening({ manifest: { sites }, now: new Date(at + 20 * 60_000), running: new Map() });
  assert.deepEqual((await listen()).pushed, routes);
  assert.deepEqual((await listen()).pushed, []);
  for (const route of routes) assert.equal(read(web('deaf-state.json'))[route].since, new Date(at + 1).toISOString());
});

const hubManifest = (owner) => {
  const dir = path.join(home, 'hub-board');
  const decoy = path.join(home, 'decoy-board');
  write(path.join(dir, 'board.json'), { title: 'Hub' });
  return { sites: {
    'hub-orchestrator': { dir: decoy, port: 2, cmd: boardCmd(decoy), owner: { session: 's-decoy', repo: otherRepo } },
    'dev-hub': { dir, port: 1, cmd: boardCmd(dir), owner, hub: true },
  } };
};
const flagged = () => Object.entries(manifest().sites).filter(([, s]) => s.hub).map(([route]) => route);

test('set --hub moves the hub flag to one board, --no-hub clears it, join --hub takes it and a later join keeps it', async () => {
  const page = { dir: repo, port: 3, cmd: [process.execPath, path.join(SKILL, 'starter', 'server.mjs')] };
  const dirA = path.join(home, 'flag-a');
  const dirB = path.join(home, 'flag-b');
  write(web('manifest.json'), { sites: { a: { dir: dirA, port: 1, cmd: boardCmd(dirA) }, b: { dir: dirB, port: 2, cmd: boardCmd(dirB), hub: true }, page } });
  assert.deepEqual(json(await cli(['set', 'a', '--hub'])), { route: 'a', icon: null, color: null, hub: true });
  assert.deepEqual(flagged(), ['a']);
  assert.equal(json(await cli(['set', 'a', '--icon', 'book'])).hub, true);
  assert.deepEqual(flagged(), ['a']);
  assert.equal(json(await cli(['set', 'a', '--no-hub'])).hub, false);
  assert.deepEqual(flagged(), []);
  json(await cli(['join', 'b', '--session', 's-b', '--hub']));
  assert.deepEqual(flagged(), ['b']);
  json(await cli(['join', 'b', '--session', 's-b']));
  assert.deepEqual(flagged(), ['b']);
  const notBoard = await cli(['set', 'page', '--hub']);
  assert.equal(notBoard.status, 2);
  assert.match(notBoard.stderr, /\/page is not a board/);
  const newPage = await cli(['join', 'new-page', '--session', 's-new', '--hub']);
  assert.equal(newPage.status, 2);
  assert.match(newPage.stderr, /\/new-page is not a board/);
  assert.equal(fs.existsSync(web('sites', 'new-page')), false);
  assert.equal(manifest().sites['new-page'], undefined);
  assert.equal((await cli(['set', 'a', '--hub', '--no-hub'])).status, 2);
  assert.deepEqual(flagged(), ['b']);
});

test('hub resumes the hub board owner in the foreground with its folder and model and inherited terminal streams', async () => {
  const m = hubManifest({ session: 's-hub', repo, model: 'opus' });
  write(web('manifest.json'), m);
  const before = calls().length;
  const r = await cli(['hub', '--repo', otherRepo], { input: 'hello hub' });
  assert.deepEqual(r, { status: 0, stdout: 'foreground stdin: hello hub\n', stderr: 'foreground stderr\n' });
  const [call] = calls().slice(before);
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', 's-hub', '--model', 'opus']);
  assert.match(call.argv.at(-1), /You are the hub session/);
  assert.ok(call.argv.at(-1).includes(path.join(SKILL, 'docs', 'hub-session.md')));
  assert.match(call.argv.at(-1), /rejoin \/dev-hub and/);
  assert.deepEqual([call.cwd, call.isolation, call.claudecode], [repo, null, null]);
  assert.deepEqual(manifest(), m);
});

test('hub starts fresh with no owner, in --repo or the cwd, with the join prompt and hub doc pointer', async () => {
  for (const options of [{ args: ['--repo', otherRepo], dir: otherRepo, owner: undefined }, { args: [], dir: repo, owner: {} }]) {
    write(web('manifest.json'), hubManifest(options.owner));
    const before = calls().length;
    const r = await cli(['hub', ...options.args]);
    assert.equal(r.status, 0, r.stderr);
    const [call] = calls().slice(before);
    assert.equal(call.argv.length, 1);
    assert.ok(call.argv[0].startsWith('/join-web-ts dev-hub --hub\n'));
    assert.match(call.argv[0], /You are the hub session/);
    assert.ok(call.argv[0].includes(path.join(SKILL, 'docs', 'hub-session.md')));
    assert.equal(call.cwd, options.dir);
  }
});

test('hub exits 2 with one line telling the owner to flag or join a hub board when no board has the flag', async () => {
  const before = calls().length;
  const page = { dir: repo, cmd: [process.execPath, path.join(SKILL, 'starter', 'server.mjs')] };
  const board = { dir: repo, cmd: boardCmd(repo), owner: { session: 's-hub', repo } };
  for (const m of [{ sites: {} }, { sites: { 'hub-orchestrator': page } }, { sites: { 'hub-orchestrator': board } }, { sites: { 'dev-hub': { ...page, hub: true } } },
    { sites: {}, starting: { 'hub-orchestrator': { session: 's-hub', repo } } }]) {
    write(web('manifest.json'), m);
    const r = await cli(['hub']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'web-ts: No hub board is flagged; flag one with web-ts set <route> --hub, or join one with web-ts join hub-orchestrator --template board --hub --session <id>\n');
  }
  assert.equal(calls().length, before);
});

test('hub keeps claude exit codes for a fresh session and a resumed owner with no model', async () => {
  for (const [owner, status] of [[undefined, 7], [{ session: 's-hub', repo }, 42]]) {
    write(web('manifest.json'), hubManifest(owner));
    write(foregroundExit, String(status));
    const r = await cli(['hub']);
    assert.equal(r.status, status);
    assert.deepEqual(calls().at(-1).argv.slice(0, -1), owner ? ['--resume', 's-hub'] : []);
  }
  fs.rmSync(foregroundExit);
});

test('hub uses an injected runner and refuses a live owner or a missing recorded folder', async () => {
  const { hubSession } = await import('./sessions.mjs');
  const m = hubManifest({ session: 's-hub', repo });
  const ran = [];
  const run = async (argv, options) => { ran.push({ argv, options }); return { status: 9 }; };
  assert.deepEqual(await hubSession({ manifest: m, run, live: () => new Map() }), { status: 9 });
  assert.deepEqual(ran[0].options, { cwd: repo });
  const before = calls().length;
  await assert.rejects(hubSession({ manifest: m, run, live: () => new Map([['s-hub', { pid: 1, kind: 'interactive' }]]) }), { reason: 'live' });
  assert.equal(ran.length, 1);
  m.sites['dev-hub'].owner.repo = path.join(home, 'gone');
  write(web('manifest.json'), m);
  const gone = await cli(['hub', '--repo', otherRepo]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /recorded folder .*gone/);
  delete m.sites['dev-hub'].owner.repo;
  write(web('manifest.json'), m);
  const r = await cli(['hub']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no folder recorded/);
  assert.equal(calls().length, before);
  assert.equal((await cli(['hub', '--repo', otherRepo])).status, 0);
  assert.deepEqual([calls().at(-1).argv.slice(0, 2), calls().at(-1).cwd], [['--resume', 's-hub'], otherRepo]);
});
