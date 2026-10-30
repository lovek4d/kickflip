import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
write(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv, cwd: process.cwd(), isolation: process.env.CLAUDE_BG_ISOLATION, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
const id = argv[argv.indexOf('--session-id') + 1] || argv[argv.indexOf('--resume') + 1];
const lingering = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });
fs.appendFileSync(${JSON.stringify(fakeLog)} + '.pids', lingering.pid + '\\n');
lingering.unref();
console.log('Started background session ' + id.slice(0, 8));
`);
fs.chmodSync(fakeClaude, 0o755);
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

test('join records the session and its folder: --repo, else the live session\'s cwd, else where join ran', async () => {
  json(await cli(['join', 'notes', '--session', 's-notes', '--label', 'Notes']));
  assert.deepEqual(manifest().sites.notes.owner, { ...manifest().sites.notes.owner, session: 's-notes', label: 'Notes', repo });
  json(await cli(['join', 'notes', '--session', 's-notes', '--repo', otherRepo, '--model', 'opus']));
  assert.deepEqual([manifest().sites.notes.owner.repo, manifest().sites.notes.owner.model, manifest().sites.notes.owner.label], [otherRepo, 'opus', 'Notes']);
  liveRecord('s-notes', path.join(repo, 'apps'));
  json(await cli(['join', 'notes', '--session', 's-notes']));
  assert.deepEqual([manifest().sites.notes.owner.repo, manifest().sites.notes.owner.model], [path.join(repo, 'apps'), 'opus']);
});

test('start runs claude --bg in the folder, in auto mode with isolation off, and records the new session as the owner', async () => {
  json(await cli(['join', 'shop', '--session', 's-old', '--title', 'Shop', '--repo', repo]));
  const t = Date.now();
  const r = json(await cli(['start', 'shop', '--model', 'opus', '--prompt', 'Pick up INT-9']));
  assert.ok(Date.now() - t < 10_000, 'start returns while what claude --bg left behind still runs');
  const [call] = calls();
  const id = call.argv[2];
  assert.deepEqual(call.argv, ['--bg', '--session-id', id, '--name', 'Shop', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'opus', '/join-web-ts shop Pick up INT-9']);
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

test('the hub resumes a board not listening for a few minutes once, never while its session is live, then pushes once', async () => {
  const boards = {};
  for (const [route, owner] of [['quiet', { session: 's-quiet', repo }], ['busy', { session: 's-busy', repo }], ['bare', { session: 's-bare' }], ['lost', { session: 's-lost', repo }]]) {
    const dir = path.join(home, 'hub-boards', route);
    write(path.join(dir, 'board.json'), { title: route[0].toUpperCase() + route.slice(1) });
    boards[route] = { dir, port: 1, cmd: boardCmd(dir), owner };
  }
  const m = { sites: boards };
  const t0 = Date.parse('2026-10-29T12:00:00Z');
  const listeningNow = new Set();
  const resumed = [];
  const pushed = [];
  const check = (min, over = {}) => checkSessions({
    manifest: m, now: new Date(t0 + min * 60_000),
    live: () => new Map([['s-busy', { pid: 1, kind: 'interactive' }]]),
    listening: (b) => listeningNow.has(b.route),
    resume: async (route) => { resumed.push([min, route]); if (route === 'lost') throw new Error('no such session'); },
    push: async (msg) => { pushed.push([min, msg.title, msg.tag, msg.body]); },
    ...over,
  });
  const resumeMin = RESUME_AFTER / 60_000;
  await check(0);
  await check(resumeMin - 0.5);
  assert.deepEqual(resumed, []);
  assert.deepEqual(await check(resumeMin), { resumed: ['quiet'], pushed: [], failed: ['lost: could not resume its session (no such session)'] });
  await check(resumeMin + 1);
  assert.deepEqual(pushed.map((p) => p.slice(0, 3)), [[resumeMin + 1, "Lost's session didn't come back", 'resume-lost']]);
  assert.match(pushed[0][3], /couldn't resume it: no such session/);
  await check(resumeMin + COMEBACK_WAIT / 60_000 - 0.5);
  assert.equal(pushed.length, 1);
  await check(resumeMin + COMEBACK_WAIT / 60_000);
  await check(60);
  assert.deepEqual(resumed, [[resumeMin, 'quiet'], [resumeMin, 'lost']]);
  assert.deepEqual(pushed.map((p) => p.slice(0, 3)), [[resumeMin + 1, "Lost's session didn't come back", 'resume-lost'], [resumeMin + COMEBACK_WAIT / 60_000, "Quiet's session didn't come back", 'resume-quiet']]);
  listeningNow.add('quiet');
  await check(61);
  assert.equal(read(web('resume-state.json')).quiet, undefined);
  listeningNow.delete('quiet');
  await check(62);
  await check(62 + resumeMin);
  assert.deepEqual(resumed.at(-1), [62 + resumeMin, 'quiet']);
  assert.ok(resumed.every(([, route]) => route !== 'busy' && route !== 'bare'));
});
