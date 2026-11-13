import { home, bin, inProcessHub } from './hub-fixture.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { until as waitUntil } from '../shared/test-helpers.mjs';

// The temp HOME hides the user's git identity, so the test repos' commits and merges get one here.
fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
for (const name of ['claude', 'gh', 'codex', 'launchctl', 'systemctl']) {
  write(path.join(bin, name), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(bin, name), 0o700);
}
write(path.join(bin, 'tailscale'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'tailscale.calls'), args.join(' ') + '\\n');
if (args.join(' ') === 'serve status --json') {
  console.error('version warning');
  console.log(fs.readFileSync(path.join(process.env.HOME, 'tailscale.status'), 'utf8'));
} else if (args.join(' ') === 'status --json') {
  console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.ts.net.' } }));
} else if (args.join(' ') === 'debug prefs') {
  console.log(JSON.stringify({ OperatorUser: require('node:os').userInfo().username }));
} else if (args.includes('--bg') && fs.existsSync(path.join(process.env.HOME, 'tailscale.fail'))) {
  console.error('permission denied by tailscaled'); process.exit(1);
} else if (args[0] === 'serve' && args.some((a) => a.startsWith('--https='))) {
  // The serve config keeps what serve --bg sets and off removes, as tailscaled does.
  const file = path.join(process.env.HOME, 'tailscale.status');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const port = args.find((a) => a.startsWith('--https=')).slice('--https='.length);
  config.TCP ||= {}; config.Web ||= {};
  if (args.at(-1) === 'off') { delete config.TCP[port]; delete config.Web['mac.ts.net:' + port]; }
  else { config.TCP[port] = { HTTPS: true }; config.Web['mac.ts.net:' + port] = { Handlers: { '/': { Proxy: args.at(-1) } } }; }
  fs.writeFileSync(file, JSON.stringify(config));
}
`);
fs.chmodSync(path.join(bin, 'tailscale'), 0o700);
// Without the pick's daemon check, which runs when this Mac has its own tailscale on PATH too.
const calls = () => fs.readFileSync(path.join(home, 'tailscale.calls'), 'utf8').trim().split('\n').filter((call) => call && call !== 'status --json');
const relayOf = (port) => calls().filter((call) => call.startsWith(`serve --bg --https=${port} `)).at(-1)?.split(' ').at(-1);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.KICKFLIP_TAILSCALE = path.join(bin, 'tailscale');
const { createTryManager, installWorktree, fetchTryBranches: fetchTimed } = await import('./try.mjs');
// The manager and the poll run each command as they would, without its time limit, so a slow host only slows a test.
const execFileAsync = promisify(execFile);
const untimed = (command, args, { timeout: _limit, ...options } = {}) => execFileAsync(command, args, options);
// A runner whose ps and lsof list only the given processes ({pid, pgid, command, cwd}), as a host would, and that runs
// every other command untimed.
const listing = (processes) => async (command, args, options) => {
  if (command === 'ps') return { stdout: processes.map((p) => `${p.pid} ${p.pgid} ${p.command}`).join('\n') + '\n' };
  if (command === 'lsof') return { stdout: processes.map((p) => `p${p.pid}\nn${p.cwd}`).join('\n') + '\n' };
  return untimed(command, args, options);
};
// A test's manager sees only the processes it lists, none unless it passes its own run.
const tryManager = (options = {}) => createTryManager({ run: listing([]), ...options });
const fetchTryBranches = (options = {}) => fetchTimed({ run: untimed, ...options });
let signalCount = 0;
// A unix socket a script signals the test through: the script runs signal(path, text), and next() resolves with the
// next signal's {text, closed}, closed resolving once the process that sent it has ended.
async function signals() {
  const file = path.join(home, `signal-${signalCount++}.sock`);
  const heard = [];
  const waiting = [];
  const server = net.createServer((socket) => {
    let text = '';
    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.on('data', (chunk) => {
      text += chunk;
      if (!text.endsWith('\n')) return;
      const signal = { text: text.trim(), closed };
      if (waiting.length) waiting.shift()(signal); else heard.push(signal);
    });
  });
  await new Promise((resolve) => server.listen(file, resolve));
  server.unref();
  return { path: file, next: () => heard.length ? Promise.resolve(heard.shift()) : new Promise((resolve) => waiting.push(resolve)) };
}
// Script text that sends text to a signals() socket and holds the connection for as long as the process lives.
const signal = (socket, text) => `require('node:net').connect(${JSON.stringify(socket.path)}).write(${JSON.stringify(text + '\n')});`;
// A port probe for the manager that answers while up() holds, and whose asked(port) resolves at the manager's first
// probe of port, which it makes once the script's port line is read.
function prober(up = () => true) {
  const asks = new Map();
  const askOf = (port) => {
    if (!asks.has(port)) { let resolve; asks.set(port, { promise: new Promise((r) => { resolve = r; }), resolve }); }
    return asks.get(port);
  };
  return { answers: async (port) => { askOf(port).resolve(); return up(port); }, asked: (port) => askOf(port).promise };
}
const { listBoards } = await import('./boards.mjs');
const { buildScriptError } = await import('../board/build-script.mjs');
const { ownerGate } = await import('../board/on-host.mjs');
let site, repo, worktree, manifest, manager, clock;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 }).trim();
const script = () => path.join(worktree, '.kickflip', 'build');
const setScript = (body, dir = worktree) => {
  const file = path.join(dir, '.kickflip', 'build');
  write(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o700);
};
const state = () => read(path.join(site, 'data', 'try.json'));
const thread = () => { try { return fs.readFileSync(path.join(site, 'data', 'threads', 'w__A1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
const start = (input = {}) => manager.start({ route: 'orch', key: 'w/A1', ...input }, { manifest });
const tick = () => manager.tick({ manifest });
const kill = (key = 'w/A1') => manager.kill({ route: 'orch', key }, { manifest });
const until = (fn) => waitUntil(fn, 'timed out waiting for try state');
const config = (extra = {}) => write(path.join(site, 'board.json'), { items: 'data/items.json', slug: 'w', ...extra });
function commit(dir, name = 'change') { git(dir, 'add', '.'); git(dir, 'commit', '--quiet', '-m', name); return git(dir, 'rev-parse', 'HEAD'); }

function fakeRelays(t) {
  const relays = [];
  t.mock.method(http, 'createServer', () => {
    const port = 49000 + relays.length;
    const relay = Object.assign(new EventEmitter(), {
      listen(_port, _host, ready) { queueMicrotask(ready); return this; },
      address: () => ({ port }),
      close(done) { relay.closed = true; queueMicrotask(done); },
    });
    relays.push(relay);
    return relay;
  });
  return relays;
}

beforeEach(() => {
  write(path.join(home, 'tailscale.calls'), '');
  write(path.join(home, 'tailscale.status'), {});
  fs.rmSync(path.join(home, 'tailscale.fail'), { force: true });
  clock = Date.now();
  site = fs.mkdtempSync(path.join(home, 'site-'));
  repo = path.join(site, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
  write(path.join(repo, 'file'), 'main');
  commit(repo);
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  worktree = path.join(home, '.claude', 'kickflip', 'worktrees', path.basename(site));
  git(repo, 'worktree', 'add', '--quiet', '-b', 'card', worktree);
  config();
  write(path.join(site, 'data', 'items.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  write(path.join(site, 'data', 'agents', 'A1.json'), { worktree: { path: worktree, repo } });
  manifest = { sites: { orch: { dir: site, cmd: [process.execPath, path.join(root, 'board/server.mjs'), site], port: 1, owner: { repo }, github: 'example/project' } } };
  manager = tryManager({ now: () => clock, log() {} });
});
afterEach(async () => {
  await manager.stop();
  for (const name of ['orch-main', 'orch-main-a', 'orch-main-b']) {
    const dir = path.join(home, '.claude/kickflip/try', name);
    if (fs.existsSync(dir)) git(repo, 'worktree', 'remove', '--force', dir);
  }
});

test('an app run uses only the fixed script and arguments, worktree cwd and build env, writes a private replacement log, and leaves builders and threads alone', async () => {
  setScript(`require('node:fs').writeFileSync('called.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), board: process.env.KICKFLIP_BOARD, host: process.env.HOST, base: process.env.KICKFLIP_BASE })); console.log('stdout'); console.error('stderr');`);
  const record = fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().kind, 'app');
  assert.equal(state().cards['w/A1'].sha, git(worktree, 'rev-parse', 'HEAD'));
  assert.deepEqual(read(path.join(worktree, 'called.json')), { args: ['w/A1', worktree], cwd: worktree, board: 'orch', host: '127.0.0.1' });
  assert.equal(fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8'), record);
  assert.deepEqual(thread(), []);
  const log = path.join(site, 'data/try/A1.log');
  assert.match(fs.readFileSync(log, 'utf8'), /stdout\nstderr\n/);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  setScript("console.log('replacement');");
  await start();
  await manager.settled();
  assert.equal(fs.readFileSync(log, 'utf8'), 'replacement\n');
  assert.equal(state().cards['w/A1'].state, 'ready');
});

test('settled() waits until every run is ready or has ended, and next(key, state) for its entry’s next move into state', async () => {
  await manager.settled();
  setScript("setInterval(() => { if (require('node:fs').existsSync('go')) process.exit(0); }, 20);");
  await start();
  let settled = false;
  const settling = manager.settled().then(() => { settled = true; });
  const ready = manager.next('w/A1', 'ready');
  await new Promise(setImmediate);
  assert.equal(settled, false, 'a run that is still building holds settled()');
  write(path.join(worktree, 'go'), '');
  await ready;
  await settling;
  assert.equal(state().cards['w/A1'].state, 'ready');
  // An entry already in the state waits for its next move into it.
  let moved = false;
  const again = manager.next('w/A1', 'ready').then(() => { moved = true; });
  await new Promise(setImmediate);
  assert.equal(moved, false);
  await start();
  await again;
  await manager.settled();
});

test('the manager runs its commands through run, a local git with no time limit, and the poll’s fetch through its own run', async () => {
  const ran = [];
  const record = (command, args, options = {}) => {
    ran.push({ command, fetch: args.includes('fetch'), timeout: options.timeout });
    if (args.includes('fetch')) return Promise.reject(Object.assign(new Error('offline'), { stderr: 'fatal: offline' }));
    return listing([])(command, args, options);
  };
  manager = tryManager({ now: () => clock, log() {}, run: record });
  setScript('process.exit(0);');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const local = ran.filter((call) => call.command === 'git');
  assert.ok(local.length);
  assert.deepEqual(local.filter((call) => call.timeout !== undefined), []);
  ran.length = 0;
  await fetchTimed({ manifest, log() {}, run: record });
  assert.deepEqual(ran.filter((call) => call.fetch).map((call) => [call.command, call.timeout]), [['git', 10_000]]);
  assert.equal(read(path.join(home, '.claude', 'kickflip', 'repo-fetch.json')).orch.error, 'fatal: offline');
});

test('script validation refuses missing, symlink, directory, foreign ownership, writable and nonexecutable files', async (t) => {
  await assert.rejects(start(), /existing regular file/);
  setScript('');
  for (const mode of [0o720, 0o702, 0o600]) {
    fs.chmodSync(script(), mode);
    await assert.rejects(start(), mode === 0o600 ? /executable/ : /writable by group or others/);
  }
  fs.chmodSync(script(), 0o700);
  const stat = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === script()) result.uid = process.getuid() + 1;
    return result;
  });
  await assert.rejects(start(), /owned by the current user/);
  mocked.mock.restore();
  fs.renameSync(script(), script() + '.real');
  fs.symlinkSync(script() + '.real', script());
  await assert.rejects(start(), /regular file/);
  fs.unlinkSync(script());
  fs.mkdirSync(script());
  await assert.rejects(start(), /regular file/);
  assert.match(buildScriptError('relative'), /absolute/);
  await assert.rejects(start({ command: '/bin/sh' }), /only the board route/);
  await assert.rejects(start({ key: 'main' }), { status: 409, message: 'Main has no failed build to retry.' });
  await assert.rejects(start({ key: 'w/missing' }), /no item/);
  await assert.rejects(start({ key: 'w/..' }), /Card key/);
  await assert.rejects(start({ route: 'missing' }), /not a board/);
});

test('worktree resolution keeps traversal, boundary, symlink and repo checks, and the newest recorded worktree wins', async () => {
  const board = listBoards(manifest)[0];
  const file = path.join(site, 'data/agents/A1.json');
  const outside = path.join(site, 'outside');
  fs.mkdirSync(outside);
  const alias = path.join(path.dirname(worktree), path.basename(worktree) + '-alias');
  fs.symlinkSync(worktree, alias);
  for (const candidate of [outside, worktree + '/..', worktree + '-missing']) {
    write(file, { worktree: { repo, path: candidate } });
    assert.equal(await installWorktree(board, 'w/A1', manifest), '');
  }
  fs.symlinkSync(outside, path.join(worktree, 'escape'));
  write(file, { worktree: { repo, path: path.join(worktree, 'escape') } });
  assert.equal(await installWorktree(board, 'w/A1', manifest), '');
  write(file, { started: '2026-01-01', worktree: { repo, path: '/old' } });
  write(path.join(site, 'data/agents/A1@build.json'), { started: '2026-02-01', done: '2026-02-02', worktree: { repo, path: alias } });
  assert.equal(await installWorktree(board, 'w/A1', manifest), worktree);
  fs.unlinkSync(file);
  fs.unlinkSync(path.join(site, 'data/agents/A1@build.json'));
  const nested = path.join(repo, '.claude/worktrees/item');
  fs.mkdirSync(nested, { recursive: true });
  write(path.join(site, 'data/items.json'), { repo: 'example/project', items: [{ id: 'A1', worktree: '.claude/worktrees/item' }] });
  assert.equal(await installWorktree(listBoards(manifest)[0], 'w/A1', manifest), nested);
  assert.equal(await installWorktree({ ...listBoards(manifest)[0], github: 'other/repo' }, 'w/A1', manifest), '');
});

test('a failed run writes one failure status line with its exit and one reason, the keychain hint before the log, a retry once it shows failed starts, and successful runs write no message', async (t) => {
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1', install: { url: 'https://example.com/app.apk' } }] });
  setScript("console.error('errSecInternalComponent'); console.log('one\\ntwo\\nthree\\nfour\\nfive'); process.exit(7);");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const append = fsp.appendFile;
  t.mock.method(fsp, 'appendFile', async (file, ...args) => {
    if (String(file).includes(`${path.sep}threads${path.sep}`)) await held;
    return append(file, ...args);
  });
  const failed = manager.next('w/A1', 'failed');
  await start();
  await failed;
  setScript('process.exit(0);');
  const retry = start();
  await new Promise(setImmediate);
  release();
  assert.deepEqual(await retry, { status: 'started' });
  assert.equal(thread().length, 1);
  assert.deepEqual([thread()[0].line, thread()[0].text, thread()[0].detail], ['run-failed', 'Build failed (exit 7)', 'unlock the login keychain on the host']);
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(thread().length, 1);
});

test('a second concurrent start returns 409', async () => {
  setScript('setInterval(() => {}, 1000);');
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  await assert.rejects(start(), { status: 409 });
});

test('a web run waits for its port and stays up with no visits while its card is open', async (t) => {
  fakeRelays(t);
  let answering = false;
  const { answers, asked } = prober(() => answering);
  manager = tryManager({ now: () => clock, answers, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  config({ auto_build: true });
  await start();
  await asked(32123);
  assert.equal(state().cards['w/A1'].state, 'running');
  answering = true;
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().kind, 'web');
  assert.equal(state().cards['w/A1'].https, 8500);
  for (let hour = 0; hour < 5; hour++) {
    clock += 60 * 60_000;
    await tick();
  }
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.deepEqual(manager.lookup('orch', 'a1', { manifest }), { key: 'w/A1', port: state().cards['w/A1'].port });
  assert.equal(calls().includes('serve --https=8500 off'), false);
  assert.deepEqual(thread(), []);
});

test('a card serve stops and drops its entry once its card is Done, its PR merged, its card gone or its worktree removed', async (t) => {
  fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  const serve = async () => {
    await start();
    await manager.settled();
    assert.equal(state().cards['w/A1'].state, 'ready');
  };
  const stopped = async () => {
    await tick();
    assert.equal(manager.lookup('orch', 'A1', { manifest }), null);
    assert.equal(state().cards['w/A1'], undefined);
  };
  await serve();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1', lane: 'done' }, { id: 'A2' }] });
  await stopped();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1', prs: [{ repo: 'example/project', number: 7 }] }, { id: 'A2' }] });
  write(path.join(home, '.claude/kickflip/github-state.json'), { prs: { 'example/project#7': { state: 'MERGED' } } });
  await serve();
  await stopped();
  fs.rmSync(path.join(home, '.claude/kickflip/github-state.json'));
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  await serve();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A2' }] });
  await stopped();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  await serve();
  git(repo, 'worktree', 'remove', '--force', worktree);
  await stopped();
});

test('a serve that exits after it was up starts again up to 3 times in 10 minutes on its port, then reads Serve failed', async (t) => {
  const relays = fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  const runsFile = path.join(home, 'runs');
  const exits = path.join(home, 'exits');
  // Run n of a round exits once the test writes go/n, after the hub has it up: an exit before then is a build that
  // failed, not a serve to restart, and a fixed delay on a loaded host can come before it.
  const go = path.join(home, 'go');
  write(exits, '2');
  setScript(`const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(runsFile)}, 'run\\n');
const runs = fs.readFileSync(${JSON.stringify(runsFile)}, 'utf8').trim().split('\\n').length;
console.log('port 32123');
setInterval(() => {}, 1000);
if (runs <= Number(fs.readFileSync(${JSON.stringify(exits)}, 'utf8'))) setInterval(() => { if (fs.existsSync(${JSON.stringify(go)} + '/' + runs)) process.exit(0); }, 20);`);
  const launches = () => fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').trim().split('\n').length : 0;
  // Run n exits once it is up, and the card's entry then reads then (ready again for a restart, failed once they run out).
  const exitThen = async (n, then) => {
    const moved = manager.next('w/A1', then);
    write(path.join(go, String(n)), '');
    await moved;
    await manager.settled();
  };
  await start();
  await manager.settled();
  for (const n of [1, 2]) await exitThen(n, 'ready');
  assert.deepEqual([launches(), relays.length, state().cards['w/A1'].state], [3, 3, 'ready']);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.match(fs.readFileSync(path.join(site, 'data/try/A1.log'), 'utf8'), /^The serve exited on its own; serving it again \(2 of 3 in 10 minutes\)\./);
  assert.deepEqual(thread(), []);
  // Ten minutes on, the earlier restarts no longer count: three more exits restart it, and a fourth reads failed.
  clock += 11 * 60_000;
  fs.rmSync(runsFile);
  fs.rmSync(go, { recursive: true });
  write(exits, '99');
  await start();
  await manager.settled();
  for (const n of [1, 2, 3]) await exitThen(n, 'ready');
  await exitThen(4, 'failed');
  assert.equal(thread().length, 1);
  assert.equal(relays.length, 7);
  assert.equal(launches(), 4);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /The serve exited on its own 4 times within 10 minutes/);
});

test('a serve past the board’s Maximum parallel serves is refused, a busy host asks first, and Auto serve waits for room', async (t) => {
  fakeRelays(t);
  let busy = false;
  manager = tryManager({ now: () => clock, answers: async () => true, busy: () => busy, log() {} });
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] });
  for (const id of ['A2', 'A3']) write(path.join(site, `data/agents/${id}.json`), { worktree: { path: worktree, repo } });
  config({ max_serves: 2 });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  await start();
  await start({ key: 'w/A2' });
  await manager.settled();
  assert.deepEqual([state().cards['w/A1'].state, state().cards['w/A2'].state], ['ready', 'ready']);
  await assert.rejects(start({ key: 'w/A3' }), (e) => e.status === 409 && e.ask === 'cap' && /cap of 2 parallel serves/.test(e.message));
  // Serving a card again takes no new slot.
  assert.deepEqual(await start(), { status: 'started' });
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  await kill('w/A2');
  busy = true;
  await assert.rejects(start({ key: 'w/A3' }), (e) => e.status === 409 && e.ask === 'busy' && e.message === 'The host is busy, start this serve anyway?');
  assert.deepEqual(await start({ key: 'w/A3', anyway: true }), { status: 'started' });
  await manager.settled();
  assert.equal(state().cards['w/A3'].state, 'ready');
  await kill('w/A3');
  // Auto serve starts nothing new on a busy host or at the cap, and serves once there is room.
  config({ auto_build: true, max_serves: 1 });
  write(path.join(worktree, 'next'), 'next');
  commit(worktree, 'next');
  await kill();
  busy = true;
  await tick();
  assert.equal(Object.values(state().cards).some((card) => card.state), false);
  busy = false;
  await tick();
  await manager.settled();
  assert.equal(Object.values(state().cards).filter((card) => card.state === 'ready').length, 1);
  await tick();
  assert.equal(Object.values(state().cards).filter((card) => card.state).length, 1);
});

test('Kill stops a running or ready serve, frees its port, and Auto serve leaves it until its head moves, across a hub restart', async (t) => {
  fakeRelays(t);
  let answering = false;
  const { answers, asked } = prober(() => answering);
  manager = tryManager({ now: () => clock, answers, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  config({ auto_build: true });
  await tick();
  await asked(32123);
  assert.equal(state().cards['w/A1'].state, 'running');
  assert.deepEqual(await kill(), { status: 'stopped' });
  assert.equal(state().cards['w/A1'].state, undefined);
  await tick();
  assert.equal(state().cards['w/A1'].state, undefined);
  answering = true;
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  await kill();
  assert.equal(manager.lookup('orch', 'A1', { manifest }), null);
  assert.ok(calls().includes('serve --https=8500 off'));
  await assert.rejects(kill(), (e) => e.status === 409);
  await manager.stop();
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  await tick();
  assert.equal(state().cards['w/A1'].state, undefined);
  assert.deepEqual(thread(), []);
  write(path.join(worktree, 'moved'), 'moved');
  commit(worktree, 'moved');
  await tick();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].killed, undefined);
});

test('a hub restart serves each card that was up again, with Auto serve off', async (t) => {
  fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  setScript("require('node:fs').appendFileSync('runs', 'run\\n'); console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  await manager.stop();
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  await manager.initialize(manifest);
  assert.equal(state().cards['w/A1'].state, 'running');
  await tick();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(fs.readFileSync(path.join(worktree, 'runs'), 'utf8'), 'run\nrun\n');
});

test('a port announcement followed by exit before readiness fails, even with exit 0', async () => {
  manager = tryManager({ answers: async () => false, log() {} });
  setScript("console.log('port 32123');");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script exited before its port answered/);
});

test('the auto-build tick refreshes head, changes and script and runs each new head only when enabled', async () => {
  setScript('process.exit(0);');
  const sha = commit(worktree);
  await tick();
  assert.deepEqual(state().cards['w/A1'], { head: sha, ahead: 1, script: true });
  const before = fs.statSync(path.join(site, 'data/try.json')).mtimeMs;
  await tick();
  assert.equal(fs.statSync(path.join(site, 'data/try.json')).mtimeMs, before);
  config({ auto_build: true });
  await tick();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const first = state().cards['w/A1'].at;
  clock += 1000;
  await tick();
  assert.equal(state().cards['w/A1'].at, first);
  setScript('process.exit(9);');
  const failedSha = commit(worktree, 'failure');
  await tick();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].sha, failedSha);
  await tick();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(thread().length, 1);
});

test('main builds at the remote tip regardless of auto_build, uses a detached worktree, and does not repeat a failed tip', async (t) => {
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'main script');
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  await tick();
  await manager.settled();
  assert.deepEqual(state().main, { sha, branch: 'main', slug: 'example/project', at: git(repo, 'log', '-1', '--format=%cI'), state: 'ready', script: true });
  const dir = path.join(home, '.claude/kickflip/try/orch-main-a');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), sha);
  assert.throws(() => git(dir, 'symbolic-ref', '-q', 'HEAD'));
  await assert.rejects(start({ key: 'main' }), { status: 409, message: 'Main has no failed build to retry.' });
  setScript(`
console.log(require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
setInterval(() => { if (!require('node:fs').existsSync('hold')) process.exit(8); }, 20);
`, repo);
  const failedSha = commit(repo, 'broken');
  git(repo, 'update-ref', 'refs/remotes/origin/main', failedSha);
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'failed');
  assert.equal(state().main.sha, failedSha);
  await tick();
  assert.equal(state().main.state, 'failed');
  const metadata = state().main;
  setScript('process.exit(0);', repo);
  const movedSha = commit(repo, 'origin moved');
  git(repo, 'update-ref', 'refs/remotes/origin/main', movedSha);
  await manager.stop();
  let reason = 'Try builds wait on Tailscale: Tailscale isn’t signed in';
  manager = tryManager({ waiting: async () => reason, log() {} });
  await assert.rejects(start({ key: 'main' }), (e) => e.status === 409 && e.message === reason);
  reason = null;
  write(path.join(dir, 'hold'), '');
  assert.deepEqual(await start({ key: 'main' }), { status: 'started' });
  await assert.rejects(start({ key: 'main' }), (e) => e.status === 409 && /already running/.test(e.message));
  fs.unlinkSync(path.join(dir, 'hold'));
  await manager.settled();
  assert.equal(state().main.state, 'failed');
  assert.deepEqual(state().main, metadata);
  assert.equal(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8').trim(), failedSha);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), failedSha);
  const stat = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === path.join(dir, '.kickflip/build')) result.mode &= ~0o111;
    return result;
  });
  await assert.rejects(start({ key: 'main' }), /executable/);
  mocked.mock.restore();
  assert.deepEqual(state().main, metadata);
  assert.match(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8'), /executable/);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(await start({ key: 'main' }), { status: 'started' });
  assert.equal(state().main.state, 'running');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), failedSha);
  await manager.settled();
  assert.equal(state().main.state, 'failed');
  assert.deepEqual(state().main, metadata);
  assert.equal(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8').trim(), failedSha);
  assert.deepEqual(thread(), []);
});

test('a board’s build target runs .kickflip/build-<target> for its cards and main, and switching it rebuilds main', async () => {
  const setTarget = (name, body, dir) => {
    const file = path.join(dir, '.kickflip', `build-${name}`);
    write(file, `#!${process.execPath}\n${body}\n`);
    fs.chmodSync(file, 0o700);
  };
  const record = (name) => `require('node:fs').writeFileSync('ran.json', JSON.stringify({ target: ${JSON.stringify(name)}, args: process.argv.slice(2), board: process.env.KICKFLIP_BOARD, host: process.env.HOST }));`;
  for (const dir of [repo, worktree]) {
    setScript(record('default'), dir);
    setTarget('web', record('web'), dir);
    setTarget('ios', record('ios'), dir);
  }
  const sha = commit(repo, 'targets');
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  fs.rmSync(path.join(worktree, '.kickflip', 'build'));
  commit(worktree, 'card targets');
  config({ build_target: 'web' });
  await tick();
  assert.equal(state().cards['w/A1'].script, true);
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  const dir = path.join(home, '.claude/kickflip/try/orch-main-a');
  assert.deepEqual(read(path.join(dir, 'ran.json')), { target: 'web', args: ['main', dir], board: 'orch', host: '127.0.0.1' });
  assert.equal(state().main.target, 'web');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.deepEqual(read(path.join(worktree, 'ran.json')), { target: 'web', args: ['w/A1', worktree], board: 'orch', host: '127.0.0.1' });
  config({ build_target: 'ios' });
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.target], ['ready', 'ios']);
  assert.equal(read(path.join(dir, 'ran.json')).target, 'ios');
  assert.equal(state().main.sha, sha);
  config({ build_target: 'android' });
  await tick();
  assert.equal(state().cards['w/A1'].script, false);
  assert.equal(state().main, null);
  config();
  await tick();
  assert.equal(state().cards['w/A1'].script, false);
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(read(path.join(dir, 'ran.json')).target, 'default');
  assert.equal(state().main.target, undefined);
});

test('a restart serves ready web cards again, keeps killed ones, clears the rest and stops main so the next tick serves it again', async () => {
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: { 'w/A1': { state: 'ready', port: 1, https: 8500, sha: 'a' }, 'w/A2': { killed: true, sha: 'b', head: 'b' }, 'w/A3': { state: 'failed' } }, main: { state: 'running', sha: 'old', script: true, serving: { sha: 'older', https: 8500 } } });
  await manager.initialize(manifest);
  assert.deepEqual(state(), { kind: 'web', cards: { 'w/A1': { state: 'running', sha: 'a' }, 'w/A2': { killed: true, sha: 'b', head: 'b' } }, main: { sha: 'old', script: true } });
});

test('builds waiting on each other when the hub restarts run after it, and one that can no longer start fails in its thread', async () => {
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] });
  for (const id of ['A2', 'A3']) write(path.join(site, `data/agents/${id}.json`), { worktree: { path: worktree, repo } });
  const lock = path.join(home, 'xcode.lock');
  const built = path.join(home, 'built');
  const keys = ['w/A1', 'w/A2', 'w/A3'];
  const building = await signals();
  setScript(`const fs = require('node:fs');
const take = () => {
  try { fs.mkdirSync(${JSON.stringify(lock)}); } catch { return setTimeout(take, 20); }
  fs.appendFileSync(${JSON.stringify(built)}, process.argv[2] + '\\n');
  ${signal(building, 'building')}
  setInterval(() => { if (!fs.existsSync('hold')) { fs.rmdirSync(${JSON.stringify(lock)}); process.exit(0); } }, 20);
};
take();`);
  const restart = async () => {
    await manager.stop();
    fs.rmSync(lock, { recursive: true, force: true });
    manager = tryManager({ now: () => clock, log() {} });
    await manager.initialize(manifest);
  };
  write(path.join(worktree, 'hold'), '');
  for (const key of keys) assert.deepEqual(await start({ key }), { status: 'started' });
  await building.next();
  await restart();
  assert.ok(keys.every((key) => state().cards[key].state === 'running'));
  fs.unlinkSync(path.join(worktree, 'hold'));
  fs.rmSync(built);
  await tick();
  await manager.settled();
  assert.ok(keys.every((key) => state().cards[key].state === 'ready'));
  assert.deepEqual(fs.readFileSync(built, 'utf8').trim().split('\n').sort(), keys);
  assert.deepEqual(thread(), []);
  write(path.join(worktree, 'hold'), '');
  await start();
  await restart();
  fs.chmodSync(script(), 0o600);
  await tick();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script must be executable/);
});

test("a web script serves root paths and upgrades through the relay to the owner and the board's shared logins alone, and keeps its port across a new commit and Retry", async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
  manager = tryManager({ now: () => clock, log() {}, gate });
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  setScript(`const server = require('node:http').createServer((req, res) => req.url === '/hold' ? res.writeHead(200).write('held') : res.end('served ' + req.url));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n' + req.url));
  server.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`);
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(manager.lookup('orch', 'a1', { manifest }).port, port);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.match(calls().find((call) => call.includes('--bg')), /^serve --bg --https=8500 http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await (await fetch(relayOf(8500) + '/nested')).text(), 'served /nested');
  const upgraded = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test' } });
    request.on('error', reject);
    request.on('upgrade', (_response, socket, head) => {
      let body = head.toString();
      socket.on('data', (chunk) => { body += chunk; });
      socket.on('end', () => { socket.destroy(); resolve(body); });
      socket.on('error', reject);
    });
    request.end();
  });
  assert.equal(upgraded, '/socket');
  // tailscale serve sends the owner's phone with its login, and anyone else is refused before the app.
  const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github' };
  assert.equal(await (await fetch(relayOf(8500) + '/nested', { headers: phone })).text(), 'served /nested');
  const friend = { 'x-forwarded-for': '100.70.1.3', 'tailscale-user-login': 'friend@github' };
  const page = await fetch(relayOf(8500) + '/nested', { headers: { ...friend, accept: 'text/html' } });
  assert.equal(page.status, 403);
  assert.match(await page.text(), /This kickflip belongs to someone else\./);
  const api = await fetch(relayOf(8500) + '/api', { method: 'POST', headers: { 'x-forwarded-for': '100.70.1.4' }, body: 'x' });
  assert.deepEqual([api.status, await api.text()], [403, '{}']);
  const refused = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test', ...friend } });
    request.on('error', reject);
    request.on('upgrade', () => reject(new Error('upgraded')));
    request.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    request.end();
  });
  assert.equal(refused, 403);
  // A login the board shares with opens its Visit links, view only (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md).
  config({ share: ['friend@github'] });
  assert.equal(await (await fetch(relayOf(8500) + '/nested', { headers: friend })).text(), 'served /nested');
  const write = await fetch(relayOf(8500) + '/api', { method: 'POST', headers: friend, body: 'x' });
  assert.deepEqual([write.status, await write.json()], [403, { error: 'This board is shared with you to look at only.' }]);
  // A shared view opens no upgrades, so nothing outlives its share but a response, which removing the share ends.
  const sharedUpgrade = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test', ...friend } });
    request.on('error', reject);
    request.on('upgrade', () => reject(new Error('upgraded')));
    request.on('response', (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve([res.statusCode, JSON.parse(body)])); });
    request.end();
  });
  assert.deepEqual(sharedUpgrade, [403, { error: 'This board is shared with you to look at only.' }]);
  const hold = (headers) => new Promise((resolve, reject) => {
    http.get(relayOf(8500) + '/hold', { headers }, (res) => {
      const held = { ended: false, res };
      res.on('data', () => {});
      held.closed = new Promise((closed) => res.on('close', () => { held.ended = true; closed(); }));
      resolve(held);
    }).on('error', reject);
  });
  const theirs = await hold(friend);
  const owners = await hold(phone);
  manager.endUnshared();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(theirs.ended, false, 'still shared, still open');
  config();
  manager.endUnshared();
  await theirs.closed;
  assert.equal(owners.ended, false, "the owner's response stays open");
  owners.res.destroy();
  assert.equal((await fetch(relayOf(8500) + '/nested', { headers: friend })).status, 403);
  commit(worktree, 'new head');
  for (let n = 0; n < 2; n++) {
    await start();
    await manager.settled();
    assert.equal(state().cards['w/A1'].state, 'ready');
    assert.equal(state().cards['w/A1'].https, 8500);
    assert.equal(await (await fetch(relayOf(8500) + '/')).text(), 'served /');
  }
  await manager.stop();
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 2, 'a stopping hub leaves the port mapped');
});

test('the relay hands the app an owner’s request without tailscale serve’s identity headers, so a gated demo hub behind it serves it', async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
  manager = tryManager({ now: () => clock, log() {}, gate });
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  // A demo hub's own gate: a login or a forwarded address sends it to its stubbed tailscale, which doesn't answer.
  setScript(`const asked = (h) => ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'x-forwarded-for'].filter((n) => n in h);
  const server = require('node:http').createServer((req, res) => asked(req.headers).length ? res.writeHead(503).end("Tailscale didn't answer") : res.end('served ' + req.url));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n' + asked(req.headers).join(',')));
  server.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`);
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github', 'tailscale-user-name': 'Love', 'tailscale-user-profile-pic': 'https://pic' };
  const page = await fetch(relayOf(8500) + '/demo/', { headers: phone });
  assert.deepEqual([page.status, await page.text()], [200, 'served /demo/']);
  const upgraded = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test', ...phone } });
    request.on('error', reject);
    request.on('upgrade', (_response, socket, head) => {
      let body = head.toString();
      socket.on('data', (chunk) => { body += chunk; });
      socket.on('end', () => { socket.destroy(); resolve(body); });
    });
    request.end();
  });
  assert.equal(upgraded, '');
});

test('a stopping hub leaves its try ports mapped, and each tick serves a gone or changed mapping again', async (t) => {
  const relays = fakeRelays(t);
  const logs = [];
  manager = tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line) });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const relay = `http://127.0.0.1:${relays[0].address().port}`;
  const served = () => calls().filter((call) => call === `serve --bg --https=8500 ${relay}`).length;
  assert.equal(served(), 1);
  await tick();
  assert.equal(served(), 1, 'a mapping that is the relay stays');
  write(path.join(home, 'tailscale.status'), { TCP: { 443: { HTTPS: true } } });
  await tick();
  assert.equal(served(), 2);
  assert.ok(logs.includes('try port 8500: its serve mapping was gone; serving it again'));
  write(path.join(home, 'tailscale.status'), { TCP: { 8500: { HTTPS: true } }, Web: { 'mac.ts.net:8500': { Handlers: { '/': { Proxy: 'http://127.0.0.1:32123' } } } } });
  await tick();
  assert.equal(served(), 3);
  assert.ok(logs.includes('try port 8500: its serve mapping was changed; serving it again'));
  await manager.stop();
  assert.ok(!calls().includes('serve --https=8500 off'));
  assert.equal(read(path.join(home, 'tailscale.status')).Web['mac.ts.net:8500'].Handlers['/'].Proxy, relay);
});

const mainDir = (side) => path.join(home, '.claude/kickflip/try', `orch-main-${side}`);
const mainPortScript = (port) => setScript(`console.log('port ${port}'); setInterval(() => {}, 1000);`, repo);
function mainCommit(name) {
  const sha = commit(repo, name);
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  return sha;
}

test('a main re-serve keeps the old server on its port until the new one answers, then hands the port over and stops the old one, building in alternating worktrees', async (t) => {
  const relays = fakeRelays(t);
  const answering = new Set([32123]);
  const { answers, asked } = prober((port) => answering.has(port));
  manager = tryManager({ now: () => clock, answers, log() {} });
  // A hub from before the alternating worktrees left one Main worktree; the next build removes it.
  git(repo, 'worktree', 'add', '--quiet', '--detach', path.join(home, '.claude/kickflip/try/orch-main'), 'HEAD');
  mainPortScript(32123);
  const first = mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main')), false);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), first);
  const at = state().main.at;
  mainPortScript(32124);
  const second = mainCommit('second');
  await tick();
  await asked(32124);
  assert.equal(git(mainDir('b'), 'rev-parse', 'HEAD'), second);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), first);
  assert.equal(state().main.state, 'running');
  assert.equal(state().main.sha, second);
  assert.deepEqual(state().main.serving, { sha: first, at, https: 8500 });
  assert.equal(relayOf(8500), 'http://127.0.0.1:49000');
  assert.equal(relays[0].closed, undefined);
  answering.add(32124);
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(state().main.serving, undefined);
  assert.equal(state().main.https, 8500);
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32124);
  assert.equal(relayOf(8500), 'http://127.0.0.1:49001');
  assert.ok(relays[0].closed);
  assert.ok(!calls().includes('serve --https=8500 off'), 'the old run leaves the port its successor holds');
  assert.equal(read(path.join(home, 'tailscale.status')).Web['mac.ts.net:8500'].Handlers['/'].Proxy, 'http://127.0.0.1:49001');
  await tick();
  assert.equal(relayOf(8500), 'http://127.0.0.1:49001');
  answering.add(32125);
  mainPortScript(32125);
  const third = mainCommit('third');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['ready', third]);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), third);
  assert.equal(git(mainDir('b'), 'rev-parse', 'HEAD'), second);
  assert.ok(relays[1].closed);
  // A hub stops every server it started, so the next hub's try.json names no old server.
  mainPortScript(32126);
  mainCommit('fourth');
  await tick();
  assert.equal(state().main.serving.https, 8500);
  await manager.stop();
  assert.ok(relays.every((relay) => relay.closed));
  manager = tryManager({ now: () => clock, answers: async () => false, log() {} });
  await manager.initialize(manifest);
  assert.equal(state().main.serving, undefined);
});

test('a build that prints the old main server’s port stops the old server before probing', async (t) => {
  const relays = fakeRelays(t);
  const probes = [];
  manager = tryManager({ now: () => clock, answers: async (port) => { probes.push([port, Boolean(relays[0]?.closed)]); return true; }, log() {} });
  mainPortScript(32123);
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  probes.length = 0;
  write(path.join(repo, 'file'), 'same port');
  const same = mainCommit('same port');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['ready', same]);
  assert.ok(probes.length);
  assert.ok(probes.every(([port, stopped]) => port === 32123 && stopped), 'the old server is gone before the new port is probed');
  assert.equal(state().main.serving, undefined);
  assert.equal(relayOf(8500), 'http://127.0.0.1:49001');
  assert.equal(read(path.join(home, 'tailscale.status')).Web['mac.ts.net:8500'].Handlers['/'].Proxy, 'http://127.0.0.1:49001');
});

// A dev server that allows one server per project, as next dev does: it exits while another of its servers runs.
const oneServerScript = (port) => setScript(`const fs = require('node:fs');
const lock = require('node:path').join(process.env.HOME, 'main.lock');
let other = 0, dir = '';
try { [other, dir] = fs.readFileSync(lock, 'utf8').split('\\n'); process.kill(Number(other), 0); } catch { other = 0; }
if (other) { console.log('Another dev server is already running. PID: ' + other + ' Dir: ' + dir); process.exit(1); }
fs.writeFileSync(lock, process.pid + '\\n' + process.cwd());
console.log('port ${port}');
setInterval(() => {}, 1000);`, repo);

test('a main serve that is refused beside the old one stops the old serve and serves once more in the same worktree, and one that fails on its own leaves the old one serving', async (t) => {
  const relays = fakeRelays(t);
  const logs = [];
  manager = tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line) });
  oneServerScript(32123);
  const first = mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  oneServerScript(32124);
  const second = mainCommit('second');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['ready', second]);
  assert.equal(state().main.serving, undefined);
  assert.equal(state().main.https, 8500);
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32124);
  assert.equal(git(mainDir('b'), 'rev-parse', 'HEAD'), second);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), first);
  assert.ok(relays[0].closed);
  assert.equal(relayOf(8500), `http://127.0.0.1:${relays.at(-1).address().port}`);
  assert.ok(logs.includes(`try /orch main: the new serve refused to run beside the old one; stopped the old serve and serving again in ${mainDir('b')}`));
  assert.match(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8'), /^The new serve exited before answering while the old one served; stopped the old serve and serving again\.\n/);
  // A commit that fails on its own, naming no worktree, fails beside the serve that keeps answering.
  setScript('console.log("broken"); process.exit(3);', repo);
  const broken = mainCommit('broken');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['failed', broken]);
  assert.equal(state().main.serving.sha, second);
  assert.equal(logs.filter((line) => line.includes('refused to run beside the old one')).length, 1);
});

test('the single main worktree of a hub from before the pair has its servers stopped and is removed, even where git refuses to remove it', async (t) => {
  fakeRelays(t);
  const logs = [];
  // Not a worktree git knows, so git worktree remove refuses it; an old Main server still runs inside it, and another
  // runs elsewhere with a file inside it on its command line.
  const legacy = path.join(home, '.claude/kickflip/try/orch-main');
  write(path.join(legacy, 'server.js'), 'setInterval(() => {}, 1000);');
  const inside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: legacy, detached: true, stdio: 'ignore' });
  const named = spawn(process.execPath, [path.join(legacy, 'server.js')], { cwd: home, detached: true, stdio: 'ignore' });
  t.after(() => { for (const child of [inside, named]) try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  manager = tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line), run: listing([
    { pid: inside.pid, pgid: inside.pid, command: `${process.execPath} -e setInterval(() => {}, 1000)`, cwd: legacy },
    { pid: named.pid, pgid: named.pid, command: `${process.execPath} ${path.join(legacy, 'server.js')}`, cwd: home },
    { pid: process.pid, pgid: process.pid, command: process.execPath, cwd: home }]) });
  const ended = (child) => new Promise((resolve) => child.once('exit', resolve));
  const gone = Promise.all([ended(inside), ended(named)]);
  mainPortScript(32123);
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  await gone;
  assert.equal(fs.existsSync(legacy), false);
  for (const child of [inside, named]) assert.ok(logs.includes(`try /orch main: stopped pid ${child.pid} (pgid ${child.pid}) in the old main worktree ${legacy}`));
  assert.ok(logs.some((line) => line.startsWith(`try /orch main: git could not remove the old main worktree ${legacy}; removed the folder: `)));
});

test('a server left in the old single main worktree is stopped even after the folder was removed under it', async (t) => {
  fakeRelays(t);
  const logs = [];
  const legacy = path.join(home, '.claude/kickflip/try/orch-main');
  fs.mkdirSync(legacy, { recursive: true });
  const inside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: legacy, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-inside.pid, 'SIGKILL'); } catch {} });
  const exited = new Promise((resolve) => inside.once('exit', resolve));
  await new Promise((resolve) => inside.once('spawn', resolve));
  fs.rmSync(legacy, { recursive: true, force: true });
  // lsof names a removed cwd by its old path.
  manager = tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line), run: listing([
    { pid: inside.pid, pgid: inside.pid, command: `${process.execPath} -e setInterval(() => {}, 1000)`, cwd: legacy }]) });
  mainPortScript(32123);
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  await exited;
  assert.ok(logs.includes(`try /orch main: stopped pid ${inside.pid} (pgid ${inside.pid}) in the old main worktree ${legacy}`));
  assert.ok(!logs.some((line) => line.includes('could not remove the old main worktree')));
});

test("a local board's main builds the tip of its recorded branch in its folder, not a branch called main", async () => {
  git(repo, 'switch', '--quiet', '-c', 'trunk');
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'trunk script');
  git(repo, 'switch', '--quiet', 'main');
  Object.assign(manifest.sites.orch, { local: true, branch: 'trunk' });
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.deepEqual([state().main.sha, state().main.branch], [sha, 'trunk']);
});

test('main keeps its fixed port across merges and restart, never idles out and uses the recorded branch and origin slug', async (t) => {
  const relays = fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);", repo);
  const sha = commit(repo, 'web main');
  // With no github, the board builds locally: from its folder's own develop.
  git(repo, 'branch', '--force', 'develop', sha);
  manifest.sites.orch.branch = 'develop';
  delete manifest.sites.orch.github;
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(state().main.slug, 'example/project');
  assert.equal(state().main.branch, 'develop');
  assert.equal(state().main_port, 8500);
  assert.equal(state().main.https, 8500);
  setScript("console.log('port 32124'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8501);
  write(path.join(repo, 'file'), 'merged');
  const merged = commit(repo, 'merge');
  git(repo, 'branch', '--force', 'develop', merged);
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(state().main.sha, merged);
  assert.equal(state().main.https, 8500);
  clock += 60 * 60_000;
  await tick();
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32123);
  await manager.stop();
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  await manager.initialize(manifest);
  assert.equal(state().main.state, undefined);
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32123);
  assert.equal(state().main_port, 8500);
  assert.equal(state().main.https, 8500);
  await manager.stop();
  assert.ok(relays.every((relay) => relay.closed));
});

test('the poll fetches each non-hub board branch into its origin ref without a network service', async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'remote main');
  git(repo, 'push', '--quiet', 'origin', 'main:develop');
  manifest.sites.orch.branch = 'develop';
  await fetchTryBranches({ manifest, log() {} });
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/develop'), sha);
});

// A git ahead of the real one on PATH: its fetch runs the shell body first, and every other command is the real git.
async function withFetchGit(body, run) {
  const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const dir = path.join(home, 'fetch-git');
  write(path.join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" fetch "*) ${body} ;; esac\nexec ${real} "$@"\n`);
  fs.chmodSync(path.join(dir, 'git'), 0o700);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { await run(); } finally { process.env.PATH = saved; }
}
const repoFetch = () => read(path.join(home, '.claude', 'kickflip', 'repo-fetch.json')).orch;

test('the poll waits out a GitHub board fetch that takes longer than a few seconds, with git prompts off', async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  write(path.join(repo, 'remote'), 'main');
  const sha = commit(repo, 'remote main');
  git(repo, 'push', '--quiet', 'origin', 'main');
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  await withFetchGit('[ "$GIT_TERMINAL_PROMPT" = 0 ] || exit 9; sleep 3.5', () => fetchTryBranches({ manifest, log() {} }));
  assert.equal(repoFetch().ok, true);
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), sha);
});

test('a GitHub board fetch git refuses records git\'s own error and the sign-in fix', async () => {
  const lines = [];
  await withFetchGit(`echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128`,
    () => fetchTryBranches({ manifest, log: (line) => lines.push(line) }));
  assert.deepEqual({ ...repoFetch(), at: undefined }, { at: undefined, ok: false,
    error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    hint: "git's github.com login can't see example/project; run gh auth setup-git" });
  assert.match(lines[0], /^fetch \/orch after \d+ ms: Command failed/);
});

test("a merge's fetch reaches only the merged board and keeps the other boards' repo-fetch records", async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  write(path.join(repo, 'file'), 'merged');
  const sha = commit(repo, 'merged on the remote');
  git(repo, 'push', '--quiet', 'origin', 'main:develop');
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/develop');
  manifest.sites.orch.branch = 'develop';
  const fetches = path.join(home, '.claude', 'kickflip', 'repo-fetch.json');
  write(fetches, { elsewhere: { at: 'earlier', ok: true } });
  await fetchTryBranches({ manifest, routes: ['elsewhere'], log() {} });
  assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/develop'));
  await fetchTryBranches({ manifest, routes: ['orch'], log() {} });
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/develop'), sha);
  assert.deepEqual(Object.keys(read(fetches)).sort(), ['elsewhere', 'orch']);
  assert.equal(read(fetches).orch.ok, true);
  await fetchTryBranches({ manifest, log() {} });
  assert.deepEqual(Object.keys(read(fetches)), ['orch']);
});

test("a merge's Main refresh covers only its board and runs after a tick already going, never alongside it", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  let checking;
  const checked = new Promise((resolve) => { checking = resolve; });
  manager = tryManager({ now: () => clock, log() {}, waiting: async () => { checks += 1; if (checks === 1) { checking(); await held; } return null; } });
  await manager.tick({ manifest, routes: ['elsewhere'] });
  assert.equal(checks, 0);
  const running = manager.tick({ manifest });
  await checked;
  const shared = manager.tick({ manifest });
  const refresh = manager.tick({ manifest, routes: ['orch'] });
  const again = manager.tick({ manifest, routes: ['orch'] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 1);
  release();
  await Promise.all([running, shared, refresh, again]);
  assert.equal(checks, 2);
});

test('on a plain git remote board the poll moves a pushed card to Done once its branch is merged or gone from the remote, and leaves an unmerged one In Review', async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  const branch = (name, file) => { git(repo, 'switch', '--quiet', '-c', name, 'main'); write(path.join(repo, file), name); commit(repo, name); git(repo, 'push', '--quiet', 'origin', name); git(repo, 'switch', '--quiet', 'main'); };
  branch('merged-one', 'merged');
  branch('open-one', 'open');
  branch('dropped-one', 'dropped');
  git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'merged-one');
  git(repo, 'push', '--quiet', 'origin', 'main', ':merged-one', ':dropped-one');
  const pushed = (b) => ({ branch: b, at: '2026-11-02T10:00:00Z' });
  write(path.join(site, 'data', 'items.json'), { items: [{ id: 'A1', lane: 'review', pushed: pushed('merged-one') }, { id: 'A2', lane: 'review', pushed: pushed('open-one') }, { id: 'A3', lane: 'review', pushed: pushed('dropped-one') }] });
  delete manifest.sites.orch.github;
  manifest.sites.orch.remote = 'git@gitlab.example.com:acme/project.git';
  await fetchTryBranches({ manifest, log() {} });
  assert.deepEqual(read(path.join(site, 'data', 'items.json')).items.map((it) => it.lane), ['done', 'review', 'done']);
  assert.equal(thread().at(-1).text, 'merged-one is merged into main on gitlab.example.com, so this card is Done.');
  assert.equal(fs.readFileSync(path.join(site, 'data', 'threads', 'w__A3.jsonl'), 'utf8').includes('dropped-one is gone from gitlab.example.com, so this card is Done.'), true);
  git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'open-one');
  git(repo, 'push', '--quiet', 'origin', 'main');
  await fetchTryBranches({ manifest, log() {} });
  assert.equal(read(path.join(site, 'data', 'items.json')).items[1].lane, 'done');
});

// A local board whose folder's origin is a bare repo here, with a second clone that pushes to it. → push(file) commits
// file in that clone, pushes it to branch and answers the new tip.
function originFor(branch = 'main') {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  git(repo, 'fetch', '--quiet', 'origin');
  const other = path.join(site, 'other');
  git(site, 'clone', '--quiet', '--branch', branch, remote, other);
  Object.assign(manifest.sites.orch, { local: true, branch });
  return (file = 'pushed') => { write(path.join(other, file), file); commit(other, file); git(other, 'push', '--quiet', 'origin', branch); return git(other, 'rev-parse', 'HEAD'); };
}
const pullEvents = (options = {}) => { const events = []; manager = tryManager({ now: () => clock, log() {}, event: async (board, kind, data) => { events.push([board.route, kind, data]); return 'e1'; }, ...options }); return events; };

test("the poll fast-forwards a local board's checked-out branch from origin, sends main-pulled, and leaves it alone when nothing is new", async () => {
  const push = originFor();
  const events = pullEvents();
  const from = git(repo, 'rev-parse', 'main');
  push('one');
  const to = push('two');
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'main'), to);
  assert.equal(fs.readFileSync(path.join(repo, 'two'), 'utf8'), 'two');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(events, [['orch', 'main-pulled', { branch: 'main', from, to, commits: 2 }]]);
  assert.deepEqual(Object.keys(state().pull), ['at']);
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(events.length, 1);
  assert.equal(state().pull.error, undefined);
});

test("a pull uses the board's recorded branch, and moves it without a checkout when no worktree has it", async () => {
  git(repo, 'branch', 'trunk');
  const push = originFor('trunk');
  const events = pullEvents();
  const tip = push();
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  const main = git(repo, 'rev-parse', 'main');
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'trunk'), tip);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(events[0][2].branch, 'trunk');
});

test('a pull only fast-forwards: local changes, a split from origin or a failed fetch refuse with the reason and leave the branch', async () => {
  const push = originFor();
  const events = pullEvents();
  push();
  const before = git(repo, 'rev-parse', 'main');
  write(path.join(repo, 'file'), 'edited here');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull.error, 'can’t pull: local changes');
  assert.equal(git(repo, 'rev-parse', 'main'), before);
  git(repo, 'checkout', '--quiet', '--', 'file');

  write(path.join(repo, 'local'), 'local');
  commit(repo, 'local only');
  const split = git(repo, 'rev-parse', 'main');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull.error, 'can’t pull: main has split from origin');
  assert.equal(git(repo, 'rev-parse', 'main'), split);

  git(repo, 'reset', '--quiet', '--hard', 'refs/remotes/origin/main');
  write(path.join(repo, 'ahead'), 'ahead');
  const ahead = commit(repo, 'ahead of origin');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull.error, undefined);
  assert.equal(git(repo, 'rev-parse', 'main'), ahead);

  await withFetchGit(`echo "fatal: unable to access 'https://example.com/': Could not resolve host" >&2; exit 128`, () => manager.pullMains({ manifest }));
  assert.equal(state().pull.error, "can’t pull: fatal: unable to access 'https://example.com/': Could not resolve host");
  assert.deepEqual(events, []);
});

test("a board whose pull throws is logged and leaves the boards after it pulled", async () => {
  const push = originFor();
  const lines = [];
  manager = tryManager({ now: () => clock, log: (...a) => lines.push(a.join(' ')), event: async () => 'e1' });
  const broken = path.join(site, 'broken');
  fs.mkdirSync(path.join(broken, 'data', 'try.json'), { recursive: true });
  manifest.sites = { broken: { dir: broken, cmd: [process.execPath, path.join(root, 'board/server.mjs'), broken], port: 2, owner: { repo }, local: true }, orch: manifest.sites.orch };
  const to = push('after');
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'main'), to);
  assert.ok(lines.some((line) => line.startsWith('pull /broken failed:')), lines.join('\n'));
});

test("a board's own clone is reset hard to origin's branch on every poll, and a local folder with no origin has no pull record", async () => {
  const push = originFor();
  pullEvents();
  delete manifest.sites.orch.local;
  write(path.join(repo, 'file'), 'edited');
  write(path.join(repo, 'stray'), 'untracked');
  git(repo, 'commit', '--quiet', '-am', 'diverged here');
  const tip = push();
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'main'), tip);
  assert.equal(fs.existsSync(path.join(repo, 'stray')), false);
  assert.deepEqual(Object.keys(state().pull), ['at']);
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  manifest.sites.orch.local = true;
  git(repo, 'remote', 'remove', 'origin');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull, undefined);
});

test('the pull reads running while it fetches, which a restart clears', async () => {
  originFor();
  // The fetch holds until the test has read try.json.
  let fetching, release;
  const fetched = new Promise((resolve) => { fetching = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  pullEvents({ run: async (command, args, options) => {
    if (command === 'git' && args.includes('fetch')) { fetching(); await held; }
    return untimed(command, args, options);
  } });
  const pulling = manager.pullMains({ manifest });
  await fetched;
  assert.equal(state().pull.running, true);
  release();
  await pulling;
  assert.equal(state().pull.running, undefined);
  const record = { ...state(), pull: { at: 'earlier', running: true } };
  write(path.join(site, 'data', 'try.json'), record);
  await manager.stop();
  manager = tryManager({ now: () => clock, log() {} });
  await manager.initialize(manifest);
  assert.deepEqual(state().pull, { at: 'earlier' });
});

test("a tap pulls now and rebuilds Main only when the pull brought commits; it resets a clone's board too", async () => {
  setScript('process.exit(0);', repo);
  commit(repo, 'script');
  const push = originFor();
  pullEvents();
  await manager.tick({ manifest });
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  const built = state().main.sha;
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 0 });
  assert.equal(state().main.sha, built);
  const tip = push();
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 1 });
  await manager.settled();
  assert.deepEqual([state().main.sha, state().main.state], [tip, 'ready']);
  write(path.join(repo, 'file'), 'edited here');
  push('again');
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 0, error: 'can’t pull: local changes' });
  await assert.rejects(manager.pull({ route: 'orch', key: 'x' }, { manifest }), { status: 400 });
  await assert.rejects(manager.pull({ route: 'nope' }, { manifest }), { status: 404 });
  delete manifest.sites.orch.local;
  const next = push('more');
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 2 });
  assert.equal(git(repo, 'rev-parse', 'main'), next);
  assert.equal(state().pull.error, undefined);
  git(repo, 'remote', 'set-url', 'origin', path.join(site, 'gone.git'));
  assert.match((await manager.pull({ route: 'orch' }, { manifest })).error, /^can’t pull: /);
  assert.match(state().pull.error, /^can’t pull: /);
});

test('the hub build route enforces loopback and fixed inputs', async (t) => {
  setScript("require('node:http').createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log('port ' + this.address().port); });");
  const web = path.join(home, '.claude/kickflip');
  write(path.join(web, 'manifest.json'), manifest);
  write(path.join(web, 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false } });
  const { port } = await inProcessHub(t);
  // Try builds wait until Tailscale serves the hub on the port KICKFLIP_HUB_PORT names (readiness.mjs), here this hub's.
  process.env.KICKFLIP_HUB_PORT = String(port);
  t.after(() => { delete process.env.KICKFLIP_HUB_PORT; });
  write(path.join(home, 'tailscale.status'), { Web: { 'mac.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });
  // Resolves once the board's try.json holds a ready w/A1. The hub's try manager replaces the file on each change, so
  // each change ends the watch on the file it replaced, and the wait watches the new one before it reads it again.
  const ready = () => new Promise((resolve) => {
    const file = path.join(site, 'data', 'try.json');
    const check = () => {
      const watcher = fs.watch(file, () => { watcher.close(); check(); });
      if (state().cards['w/A1']?.state === 'ready') { watcher.close(); resolve(); }
    };
    check();
  });
  // POSTs body to the hub's /_hub/<route> → its status code. http.request, not fetch, so a test can set Host.
  const call = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: `/_hub/${route}`, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  const outside = [{ origin: 'https://mac.ts.net' }, { 'x-forwarded-for': '100.64.0.1' }, { host: 'mac.ts.net' }];
  const input = { route: 'orch', key: 'w/A1' };
  for (const headers of outside) assert.equal(await call('build', input, headers), 403);
  assert.equal(await call('build', { ...input, command: '/bin/sh' }), 400);
  assert.equal(await call('build', { ...input, key: 'main' }), 409);
  assert.equal(await call('build', input), 202);
  await ready();
  for (const headers of outside) assert.equal(await call('kill', input, headers), 403);
  assert.equal(await call('kill', { ...input, anyway: true }), 400);
  assert.equal(await call('kill', input), 200);
  assert.equal(state().cards['w/A1'].state, undefined);
  assert.equal(await call('kill', input), 409);
  for (const headers of outside) assert.equal(await call('pull', { route: 'orch' }, headers), 403);
  assert.equal(await call('pull', { route: 'orch', key: 'main' }), 400);
  assert.equal(await call('pull', { route: 'orch' }), 200);
});

test('a running script with no port fails after sixty minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setScript('setInterval(() => {}, 1000);');
  await start();
  t.mock.timers.tick(59 * 60_000);
  assert.equal(state().cards['w/A1'].state, 'running');
  t.mock.timers.tick(60_000);
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /No port line within 60 minutes/);
  t.mock.timers.reset();
});

test('an unanswered announced port fails after sixty seconds', async () => {
  const { answers, asked } = prober(() => false);
  manager = tryManager({ now: () => clock, answers, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await asked(32123);
  clock += 61_000;
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /Nothing answered.*60 seconds/);
});

test('shutdown kills the whole process group, escalating when a server ignores SIGTERM, with no failure message, and refuses new starts', async () => {
  // No grace: the stop escalates to SIGKILL at once, which the server needs.
  manager = tryManager({ now: () => clock, log() {}, grace: 0 });
  const up = await signals();
  const server = `process.on('SIGTERM', () => {}); ${signal(up, 'server')} setInterval(() => {}, 1000);`;
  setScript(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
  await start();
  const { closed } = await up.next();
  await manager.stop();
  // The server ignored SIGTERM, so its socket closes only once the SIGKILL reached it.
  await closed;
  assert.deepEqual(thread(), []);
  await assert.rejects(start(), /hub is stopping/);
});

test('an automatic validation refusal records one failed head and useful thread log, while a main failure survives restart', async () => {
  config({ auto_build: true });
  setScript('process.exit(0);');
  fs.chmodSync(script(), 0o600);
  const sha = commit(worktree, 'not executable');
  await tick();
  assert.equal(state().cards['w/A1'].sha, sha);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script must be executable/);
  await tick();
  assert.equal(thread().length, 1);
  setScript('process.exit(0);', repo);
  const mainSha = commit(repo, 'main script');
  git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
  await manager.stop();
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: {}, main: { sha: mainSha, state: 'failed', script: true } });
  manager = tryManager({ log() {} });
  await manager.initialize(manifest);
  await tick();
  assert.equal(state().main.state, 'failed');
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main-a')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main-b')), false);
});

test('startup removes only unowned in-range ports and parses stdout despite a version warning', async () => {
  write(path.join(home, 'tailscale.status'), { TCP: { 443: {}, 8499: {}, 8500: {}, 8599: {}, 8600: {} } });
  await manager.initialize(manifest);
  assert.deepEqual(calls(), ['serve status --json', 'serve --https=8500 off', 'serve --https=8599 off']);
});

test('a failed Tailscale registration fails the run with stderr and removes the port, and a served card whose server dies serves again', async (t) => {
  const relays = fakeRelays(t);
  manager = tryManager({ answers: async () => true, log() {} });
  write(path.join(home, 'tailscale.fail'), 'yes');
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(state().cards['w/A1'].https, undefined);
  assert.match(thread()[0].detail, /Couldn't open try port 8500: permission denied by tailscaled/);
  assert.ok(relays[0].closed);
  assert.ok(calls().includes('serve --https=8500 off'));
  fs.rmSync(path.join(home, 'tailscale.fail'));
  setScript("require('node:fs').writeFileSync('server.pid', String(process.pid)); console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8500);
  // A served card whose server is stopped outside the hub serves again on its port, with no thread line.
  const servedAgain = manager.next('w/A1', 'ready');
  process.kill(Number(fs.readFileSync(path.join(worktree, 'server.pid'), 'utf8')), 'SIGTERM');
  await servedAgain;
  await manager.settled();
  assert.equal(relays.length, 3);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 2);
  assert.ok(relays.slice(0, 2).every((relay) => relay.closed));
  assert.equal(thread().length, 1);
});

test('card ports skip every board’s fixed main port, including closed boards, and release on Kill', async (t) => {
  fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  const other = path.join(home, 'other');
  write(path.join(other, 'data/try.json'), { main_port: 8500 });
  manifest.closed = { other: { site: { dir: other } } };
  write(path.join(site, 'data/try.json'), { kind: 'web', main_port: 8501, cards: {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8502);
  await kill();
  assert.ok(calls().includes('serve --https=8502 off'));
  assert.equal(state().main_port, 8501);
  write(path.join(site, 'data/agents/A2.json'), { worktree: { path: worktree, repo } });
  await start({ key: 'w/A2' });
  await manager.settled();
  assert.equal(state().cards['w/A2'].state, 'ready');
  assert.equal(state().cards['w/A2'].https, 8502);
  manifest.sites = {};
  await tick();
  assert.equal(calls().filter((call) => call === 'serve --https=8502 off').length, 2);
  assert.equal(state().cards['w/A2'], undefined);
});

test('exhausted try ports fail clearly without adding a serve entry', async () => {
  manager = tryManager({ answers: async () => true, log() {} });
  manifest.closed = {};
  for (let port = 8500; port <= 8599; port++) {
    const dir = path.join(home, `reserved-${port}`);
    write(path.join(dir, 'data/try.json'), { main_port: port });
    manifest.closed[port] = { site: { dir } };
  }
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.match(thread()[0].detail, /No try ports available \(8500–8599\)/);
  assert.equal(calls().some((call) => call.includes('--bg')), false);
});

test('startup cleanup failure logs and still allows a build', async () => {
  const logs = [];
  manager = tryManager({ log: (line) => logs.push(line) });
  write(path.join(home, 'tailscale.status'), 'not json');
  await manager.initialize(manifest);
  assert.match(logs[0], /try startup cleanup/);
  setScript('process.exit(0);');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
});

test('try builds refuse with 409 while waiting and main rebuilds wait without a failure', async () => {
  const reason = 'Try builds wait on Tailscale: Tailscale / is not serving the hub.';
  const launched = path.join(home, 'build-started');
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`);
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`, repo);
  commit(repo);
  const messages = [];
  manager = tryManager({ waiting: async () => reason, log: (text) => messages.push(text) });
  await assert.rejects(start(), (error) => error.status === 409 && error.message === reason);
  await tick();
  assert.equal(fs.existsSync(launched), false);
  assert.equal(state().main, null);
  assert.equal(Object.values(state().cards).some((card) => card.state === 'failed' || card.state === 'running'), false);
  assert.deepEqual(thread(), []);
  assert.deepEqual(messages, []);
});

test("the prototype serve's relay drops the headers that refuse a frame, and a card's relay keeps them", async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
  manager = tryManager({ now: () => clock, answers: async () => true, log() {}, gate });
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  const free = async () => {
    const server = http.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  };
  const framed = (port) => `const s = require('node:http').createServer((q, r) => { r.setHeader('X-Frame-Options', 'SAMEORIGIN'); r.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'"); r.end('page'); });
  s.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`;
  setScript(framed(await free()), base);
  setScript(framed(await free()));
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'A' }] }] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [{ topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'A' }] }] });
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const proto = await fetch(relayOf(state().prototypes.https) + '/');
  assert.equal(proto.headers.get('x-frame-options'), null);
  assert.equal(proto.headers.get('content-security-policy'), "default-src 'self'");
  const card = await fetch(relayOf(state().cards['w/A1'].https) + '/');
  assert.equal(card.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(card.headers.get('content-security-policy'), /frame-ancestors/);
  await manager.stop();
  git(repo, 'worktree', 'remove', '--force', base);
});

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
test("the board's base prototype worktree is served while an open question links a served round: never idle, back after a restart, stopped once resolved, and a failure waits for Try again", async (t) => {
  fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  setScript("console.log('port 32125'); setInterval(() => {}, 1000);", base);
  const ownerFile = path.join(site, 'data', 'owner.json');
  const round = (extra = {}) => write(ownerFile, { topics: [], items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'A' }], ...extra }] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [{ topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'A' }] }] });
  await tick();
  assert.ok(!state().prototypes);
  round();
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(state().prototypes.https, 8500);
  clock += 2 * 60 * 60_000;
  await tick();
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32125);
  await manager.stop();
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  await manager.initialize(manifest);
  assert.ok(!state().prototypes?.state);
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  round({ resolved: '2026-11-06T10:00:00Z' });
  clock += 31 * 60_000;
  await tick();
  assert.ok(!state().prototypes);
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }), null);
  round();
  setScript('process.exit(3);', base);
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'failed');
  setScript("console.log('port 32126'); setInterval(() => {}, 1000);", base);
  await tick();
  assert.equal(state().prototypes.state, 'failed');
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32126);
  assert.match(fs.readFileSync(path.join(site, 'data', 'try', 'prototypes.log'), 'utf8'), /port 32126/);
  assert.deepEqual(thread(), []);
});

// docs/adr/2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md
test("a move of the base worktree to a new commit restarts its serve on the same https port as a new run, and an unmoved base keeps its run", async (t) => {
  fakeRelays(t);
  const logs = [];
  manager = tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line) });
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  const counter = path.join(home, 'base-port');
  setScript(`const fs = require('node:fs'); const f = ${JSON.stringify(counter)}; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 32125;
fs.writeFileSync(f, String(n)); console.log('port ' + n); setInterval(() => {}, 1000);`, base);
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'A' }] }] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [{ topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'A' }] }] });
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  const first = state().prototypes;
  assert.ok(first.since);
  clock += 60_000;
  await tick();
  assert.equal(state().prototypes.since, first.since);
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32125);

  write(path.join(repo, 'moved.txt'), 'moved');
  const moved = commit(repo, 'moved');
  git(base, 'checkout', '--quiet', '--detach', moved);
  clock += 60_000;
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32126);
  assert.equal(state().prototypes.https, first.https);
  assert.equal(state().prototypes.sha, moved);
  assert.notEqual(state().prototypes.since, first.since);
  assert.ok(logs.some((line) => line.includes(`prototypes: the base moved to ${moved.slice(0, 7)}; restarting its serve`)), logs.join('\n'));
});

test('a run’s process group is recorded in try.json while it runs and forgotten once it ends', async () => {
  const { answers, asked } = prober(() => false);
  manager = tryManager({ now: () => clock, answers, log() {} });
  setScript(`console.log('port ' + 1); setInterval(() => {}, 1000);`);
  await start();
  await asked(1);
  assert.deepEqual(state().groups[0], { pgid: state().groups[0].pgid, key: 'w/A1', worktree, port: 1 });
  await manager.stop();
  assert.equal(state().groups, undefined);
});

test('a hub that died hard stops a recorded group still running its script at startup, and leaves one outside the worktree', async (t) => {
  const logs = [];
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, detached: true, stdio: 'ignore' });
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: home, detached: true, stdio: 'ignore' });
  t.after(() => { for (const child of [leftover, stranger]) try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const command = `${process.execPath} -e setInterval(() => {}, 1000)`;
  manager = tryManager({ now: () => clock, log: (line) => logs.push(line), run: listing([
    { pid: leftover.pid, pgid: leftover.pid, command, cwd: worktree }, { pid: stranger.pid, pgid: stranger.pid, command, cwd: home }]) });
  write(path.join(site, 'data/try.json'), { kind: 'app', cards: { 'w/A1': { state: 'running' } }, main: null, groups: [
    { pgid: leftover.pid, key: 'w/A1', worktree }, { pgid: stranger.pid, key: 'w/A2', worktree }, { pgid: 2 ** 22 - 1, key: 'w/A3', worktree }] });
  await manager.initialize(manifest);
  assert.throws(() => process.kill(-leftover.pid, 0));
  assert.doesNotThrow(() => process.kill(-stranger.pid, 0));
  assert.ok(logs.includes(`stopped leftover try /orch w/A1 (pgid ${leftover.pid})`));
  assert.equal(state().groups, undefined);
});

test('a stopped leftover whose port still answers posts a red fault on its card', async (t) => {
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-leftover.pid, 'SIGKILL'); } catch {} });
  manager = tryManager({ now: () => clock, log() {}, lingers: async () => true, run: listing([
    { pid: leftover.pid, pgid: leftover.pid, command: `${process.execPath} -e setInterval(() => {}, 1000)`, cwd: worktree }]) });
  write(path.join(site, 'data/try.json'), { kind: 'app', cards: {}, main: null, groups: [{ pgid: leftover.pid, key: 'w/A1', worktree, port: 4321 }] });
  await manager.initialize(manifest);
  assert.match(JSON.stringify(thread()), /Port 4321 still answers after the run was stopped/);
});

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
test("with no open question the base serve stays up for 30 minutes after a viewer's ask: an ask on a ready serve only stamps the visit, and a stale one lets it stop", async (t) => {
  fakeRelays(t);
  manager = tryManager({ now: () => clock, answers: async () => true, log() {} });
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  setScript("console.log('port 32125'); setInterval(() => {}, 1000);", base);
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [] });
  await tick();
  assert.ok(!state().prototypes);
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  const first = state().prototypes;
  clock += 20 * 60_000;
  await tick();
  assert.equal(state().prototypes.since, first.since, 'a recent ask keeps it');
  assert.deepEqual(await manager.start({ route: 'orch', key: 'prototypes' }, { manifest }), { status: 'ready' });
  assert.equal(state().prototypes.since, first.since, 'an ask on a ready serve does not restart it');
  clock += 20 * 60_000;
  await tick();
  assert.equal(state().prototypes.since, first.since, 'the ask moved the 30 minutes on');
  clock += 11 * 60_000;
  await tick();
  assert.ok(!state().prototypes, 'a stale ask stops it');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }), null);
});
