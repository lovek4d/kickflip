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
process.env.WEB_TS_CLAUDE = fakeClaude;
write(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv[0] === 'agents') { let list = []; try { list = JSON.parse(fs.readFileSync(${JSON.stringify(agentsFile)}, 'utf8')); } catch {} console.log(JSON.stringify(list)); process.exit(0); }
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

const cli = (args, { cwd = repo } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(SKILL, 'bin', 'web-ts.mjs'), ...args], {
    cwd, env: { ...process.env, HOME: home, WEB_TS_CLAUDE: fakeClaude, WEB_TS_HUB_PORT: '1', CLAUDECODE: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
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
  const r = json(await cli(['start', 'fresh', '--repo', otherRepo]));
  const call = calls()[before];
  assert.deepEqual([call.argv.at(-1), call.cwd, call.argv.includes('--model')], ['/join-web-ts fresh', otherRepo, false]);
  assert.deepEqual(manifest().starting.fresh, { ...manifest().starting.fresh, session: r.session, repo: otherRepo });
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
    push: async (msg) => { pushed.push([min, msg.title, msg.tag, msg.body]); },
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
