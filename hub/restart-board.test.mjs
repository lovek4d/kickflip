import { home as scratch, web, write, inProcessHub, serverSignals } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts } from '../shared/test-helpers.mjs';
import { restartBoard } from './restart-board.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const boardServer = path.join(HUB_DIR, '..', 'board', 'server.mjs');
const id = '12345678-1234-1234-1234-123456789abc';
const hubId = '87654321-4321-4321-4321-cba987654321';

function fakeClaude(home) {
  const file = path.join(home, 'bin', 'claude');
  const sessions = path.join(home, '.claude', 'sessions');
  write(file, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const sessions = ${JSON.stringify(sessions)};
const pidFile = ${JSON.stringify(path.join(home, '.claude', 'kickflip', 'run', 'shop.pid'))};
fs.appendFileSync(${JSON.stringify(path.join(home, 'calls.jsonl'))}, JSON.stringify({ argv, cwd: process.cwd(), server: fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : null }) + '\\n');
if (argv[0] === 'stop') {
  for (const f of fs.readdirSync(sessions)) {
    const r = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8'));
    if (r.jobId === argv[1]) { try { process.kill(r.pid); } catch {} fs.unlinkSync(path.join(sessions, f)); }
  }
} else if (argv[0] === 'agents') console.log(JSON.stringify([{ sessionId: ${JSON.stringify(id)}, kind: 'background' }]));
else if (argv[0] === '--resume') {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  c.unref();
  fs.writeFileSync(path.join(sessions, c.pid + '.json'), JSON.stringify({ pid: c.pid, sessionId: argv[1], jobId: argv[1].slice(0, 8), kind: 'bg' }));
  console.log('backgrounded · ' + argv[1].slice(0, 8) + ' · Shop');
}
`);
  fs.chmodSync(file, 0o755);
  return file;
}

// A stand-in tmux: logs each call; has-session finds no session, so the hub board's resume starts one.
function fakeTmux(home) {
  const file = path.join(home, 'bin', 'tmux');
  write(file, `#!${process.execPath}
const argv = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(path.join(home, 'tmux.jsonl'))}, JSON.stringify(argv) + '\\n');
process.exit(argv[0] === 'has-session' ? 1 : 0);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

// args go before the board server's script in its cmd (serverSignals' args).
function board(home, route, port, extra, args = []) {
  const dir = path.join(home, '.claude', 'kickflip', 'sites', route);
  write(path.join(dir, 'board.json'), { title: route, items: 'data/cards.json' });
  write(path.join(dir, 'data', 'cards.json'), { items: [] });
  return { dir, port, cmd: [process.execPath, ...args, boardServer, dir], ...extra };
}

test("Restart stops a board's session, restarts its server and resumes the session once the new server answers, the hub board's in its tmux session", async (t) => {
  const home = scratch;
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  const [shopPort, hubPort] = await freePorts(2);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const claude = fakeClaude(home);
  const tmux = fakeTmux(home);
  const env = { KICKFLIP_CLAUDE: process.env.KICKFLIP_CLAUDE, KICKFLIP_TMUX: process.env.KICKFLIP_TMUX };
  Object.assign(process.env, { KICKFLIP_CLAUDE: claude, KICKFLIP_TMUX: tmux });
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => {
    Object.assign(process.env, env);
    sleeper.kill();
    for (const f of fs.readdirSync(path.join(home, '.claude', 'sessions'))) {
      try { process.kill(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', f), 'utf8')).pid); } catch {}
    }
  });
  write(path.join(home, '.claude', 'sessions', `${sleeper.pid}.json`), { pid: sleeper.pid, sessionId: id, jobId: id.slice(0, 8), kind: 'bg' });
  const signal = await serverSignals(t);
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {
    shop: board(home, 'shop', shopPort, { title: 'The Shop', owner: { session: id, repo, label: 'Shop' } }, signal.args),
    'hub-orchestrator': board(home, 'hub-orchestrator', hubPort, { title: 'Hub', hub: true, owner: { session: hubId, repo, label: 'Hub' } }, signal.args),
  } });
  const hub = await inProcessHub(t);
  const base = hub.base;
  const calls = () => fs.readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const restart = (route) => fetch(`${base}/_hub/restart-board`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route }) });
  {
    await signal.up();
    await signal.up();
    await hub.reconcile();
    assert.ok((await fetch(`${base}/shop/_claude/health`)).ok, 'the Shop server answers');
    const groups = (await (await fetch(`${base}/_hub/api/hub`)).json()).groups;
    assert.deepEqual(groups.flatMap((g) => g.sites.map((s) => [s.route, s.restart])), [['hub-orchestrator', true], ['shop', true]]);
    const before = fs.readFileSync(path.join(home, '.claude', 'kickflip', 'run', 'shop.pid'), 'utf8');

    const stranger = await fetch(`${base}/_hub/restart-board`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.70.1.4' }, body: JSON.stringify({ route: 'shop' }) });
    assert.deepEqual([stranger.status, await stranger.json()], [403, {}]);
    assert.equal(fs.existsSync(path.join(home, 'calls.jsonl')), false);
    const r = await restart('shop');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { route: 'shop', title: 'The Shop', session: id });
    const made = calls();
    assert.deepEqual(made.map((c) => c.argv[0]), ['stop', 'agents', '--resume']);
    assert.deepEqual(made[0].argv, ['stop', id.slice(0, 8)]);
    assert.deepEqual(made.at(-1).argv.slice(0, 3), ['--resume', id, '--bg']);
    assert.ok(made.every((c) => c.cwd === repo));
    assert.equal(made[0].server, before);
    assert.notEqual(made.at(-1).server, before);
    assert.ok(made.at(-1).server);
    if (sleeper.exitCode === null && sleeper.signalCode === null) await once(sleeper, 'exit');
    assert.equal(sleeper.exitCode ?? sleeper.signalCode, 'SIGTERM');
    const manifest = JSON.parse(fs.readFileSync(path.join(web, 'manifest.json'), 'utf8'));
    assert.equal(typeof manifest.sites.shop.restart_at, 'number');
    assert.equal(manifest.sites.shop.owner.session, id);
    assert.equal(manifest.sites['hub-orchestrator'].restart_at, undefined);
    assert.ok((await fetch(`${base}/shop/_claude/health`)).ok);
    assert.equal(fs.existsSync(path.join(home, 'tmux.jsonl')), false);

    const hubRestart = await restart('hub-orchestrator');
    assert.equal(hubRestart.status, 200);
    assert.deepEqual(await hubRestart.json(), { route: 'hub-orchestrator', title: 'Hub', session: hubId });
    const tmuxCalls = fs.readFileSync(path.join(home, 'tmux.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(tmuxCalls.map((a) => a.slice(0, 6)), [['has-session', '-t', '=kickflip-hub-orchestrator'], ['has-session', '-t', '=kickflip-hub-orchestrator'], ['new-session', '-d', '-s', 'kickflip-hub-orchestrator', '-c', repo]]);
    const started = tmuxCalls[2];
    assert.deepEqual([started.includes(claude), started[started.indexOf('--resume') + 1], started.includes('--bg')], [true, hubId, false]);
    assert.ok(started.includes('--settings'));
    assert.equal(calls().length, made.length);
  }
});

function unitRun(running) {
  const steps = [];
  const run = async (argv) => { steps.push(argv[0]); return { status: 0, stdout: argv[0] === 'agents' ? '[]' : `backgrounded · ${id.slice(0, 8)} · Shop`, stderr: '' }; };
  return { steps, opts: { live: () => running.value, run, stop: async () => { steps.push('stop'); running.value = new Map(); } } };
}
function setupShop(port) {
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  write(path.join(scratch, '.claude', 'kickflip', 'manifest.json'), { version: 1, sites: { shop: board(scratch, 'shop', port, { title: 'The Shop', owner: { session: id, repo } }) } });
  return { value: new Map([[id, { sessionId: id, pid: 1, kind: 'bg', jobId: id.slice(0, 8) }]]) };
}

test("a session back before its server answers keeps waiting on the server's port, and the restart succeeds once it answers", async () => {
  const { steps, opts } = unitRun(setupShop(4321));
  let t = 0;
  const checked = [];
  const starting = [];
  const result = await restartBoard('shop', {
    ...opts,
    serverUp: async () => false,
    portUp: async (port) => { checked.push([port, t]); return t >= 45_000; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    onStarting: (title) => starting.push(title),
  });
  assert.deepEqual([result.route, result.title], ['shop', 'The Shop']);
  assert.deepEqual(starting, ['The Shop']);
  assert.ok(checked.every(([port]) => port === 4321) && checked.length > 1);
  assert.deepEqual(steps, ['stop', 'agents', '--resume']);
});

test("a server whose port never answers within the limit is reported still starting, after its session is resumed", async () => {
  const { steps, opts } = unitRun(setupShop(4321));
  let t = 0;
  await assert.rejects(restartBoard('shop', {
    ...opts,
    serverUp: async () => false,
    portUp: async () => false,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    onStarting() {},
  }), (e) => e.status === 504 && /The Shop’s session is back, but its server is still starting after 2 minutes\. See kickflip logs shop\./.test(e.message));
  assert.ok(t >= 120_000 && t < 130_000, `waited ${t}ms`);
  assert.deepEqual(steps, ['stop', 'agents', '--resume']);
});

test("a server that answers at once is not waited on", async () => {
  const { opts } = unitRun(setupShop(4321));
  const starting = [];
  await restartBoard('shop', { ...opts, serverUp: async () => true, portUp: async () => { throw new Error('polled'); }, onStarting: (t) => starting.push(t) });
  assert.deepEqual(starting, []);
});
