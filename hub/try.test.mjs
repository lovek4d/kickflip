import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { until as waitUntil } from '../shared/test-helpers.mjs';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'try-')));
process.env.HOME = home;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const bin = path.join(home, 'bin');
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
} else if (args.includes('--bg') && fs.existsSync(path.join(process.env.HOME, 'tailscale.fail'))) {
  console.error('permission denied by tailscaled'); process.exit(1);
}
`);
fs.chmodSync(path.join(bin, 'tailscale'), 0o700);
const calls = () => fs.readFileSync(path.join(home, 'tailscale.calls'), 'utf8').trim().split('\n').filter(Boolean);
const relayOf = (port) => calls().filter((call) => call.startsWith(`serve --bg --https=${port} `)).at(-1)?.split(' ').at(-1);
process.env.PATH = `${bin}:${process.env.PATH}`;
const { createTryManager, installWorktree, fetchTryBranches } = await import('./try.mjs');
const { listBoards } = await import('./boards.mjs');
const { buildScriptError } = await import('../board/build-script.mjs');
let site, repo, worktree, manifest, manager, clock;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000 }).trim();
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
const until = (fn) => waitUntil(fn, 'timed out waiting for try state');
const config = (extra = {}) => write(path.join(site, 'board.json'), { items: 'data/wave.json', slug: 'w', ...extra });
function commit(dir, name = 'change') { git(dir, 'add', '.'); git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', name); return git(dir, 'rev-parse', 'HEAD'); }

function fakeRelays(t) {
  const relays = [];
  t.mock.method(net, 'createServer', (accept) => {
    const port = 49000 + relays.length;
    const relay = Object.assign(new EventEmitter(), {
      listen(_port, _host, ready) { queueMicrotask(ready); return this; },
      address: () => ({ port }),
      close(done) { relay.closed = true; queueMicrotask(done); },
    });
    relay.on('connection', accept);
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
  write(path.join(site, 'data', 'wave.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  write(path.join(site, 'data', 'agents', 'A1.json'), { worktree: { path: worktree, repo } });
  manifest = { sites: { orch: { dir: site, cmd: [process.execPath, path.join(root, 'board/server.mjs'), site], port: 1, owner: { repo }, github: 'example/project' } } };
  manager = createTryManager({ now: () => clock, log() {} });
});
afterEach(async () => {
  await manager.stop();
  const dir = path.join(home, '.claude/kickflip/try/orch-main');
  if (fs.existsSync(dir)) git(repo, 'worktree', 'remove', '--force', dir);
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('an app run uses only the fixed script and arguments, worktree cwd and build env, writes a private replacement log, and leaves builders and threads alone', async () => {
  setScript(`require('node:fs').writeFileSync('called.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), board: process.env.KICKFLIP_BOARD, base: process.env.KICKFLIP_BASE })); console.log('stdout'); console.error('stderr');`);
  const record = fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8');
  await start();
  await until(() => state().cards['w/A1']?.state === 'ready');
  assert.equal(state().kind, 'app');
  assert.equal(state().cards['w/A1'].sha, git(worktree, 'rev-parse', 'HEAD'));
  assert.deepEqual(read(path.join(worktree, 'called.json')), { args: ['w/A1', worktree], cwd: worktree, board: 'orch' });
  assert.equal(fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8'), record);
  assert.deepEqual(thread(), []);
  const log = path.join(site, 'data/try/A1.log');
  assert.match(fs.readFileSync(log, 'utf8'), /stdout\nstderr\n/);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  setScript("console.log('replacement');");
  await start();
  await until(() => fs.readFileSync(log, 'utf8') === 'replacement\n' && state().cards['w/A1'].state === 'ready');
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
  write(path.join(site, 'data/wave.json'), { repo: 'example/project', items: [{ id: 'A1', worktree: '.claude/worktrees/item' }] });
  assert.equal(await installWorktree(listBoards(manifest)[0], 'w/A1', manifest), nested);
  assert.equal(await installWorktree({ ...listBoards(manifest)[0], github: 'other/repo' }, 'w/A1', manifest), '');
});

test('a failed run writes one failure with its exit, keychain hint and last five log lines; successful runs write no message', async () => {
  write(path.join(site, 'data/wave.json'), { items: [{ id: 'A1', install: { url: 'https://example.com/app.apk' } }] });
  setScript("console.error('errSecInternalComponent'); console.log('one\\ntwo\\nthree\\nfour\\nfive'); process.exit(7);");
  await start();
  await until(() => thread().length === 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(thread()[0].text, 'Build failed (exit 7)\nThe login keychain must be unlocked on the Mac.\none\ntwo\nthree\nfour\nfive');
  setScript('process.exit(0);');
  await start();
  await until(() => state().cards['w/A1'].state === 'ready');
  assert.equal(thread().length, 1);
});

test('a second concurrent start returns 409, while a legacy install_script setting is ignored', async () => {
  config({ install_script: '/caller/selected/script' });
  setScript('setInterval(() => {}, 1000);');
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  await assert.rejects(start(), { status: 409 });
});

test('a web run waits for its port, uses the relay to reset idle, and removes its public port on idle', async (t) => {
  const relays = fakeRelays(t);
  const peer = () => new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const upstream = peer();
  t.mock.method(net, 'connect', () => upstream);
  let answering = false;
  manager = createTryManager({ now: () => clock, answers: async () => answering, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  config({ auto_build: true });
  await start();
  await until(() => fs.readFileSync(path.join(site, 'data/try/A1.log'), 'utf8').includes('port'));
  assert.equal(state().cards['w/A1'].state, 'running');
  answering = true;
  await until(() => state().cards['w/A1'].state === 'ready');
  assert.equal(state().kind, 'web');
  clock += 29 * 60_000;
  assert.deepEqual(manager.lookup('orch', 'a1', { manifest }), { key: 'w/A1', port: state().cards['w/A1'].port });
  assert.equal(state().cards['w/A1'].https, 8500);
  const socket = peer();
  relays[0].emit('connection', socket);
  clock += 29 * 60_000;
  await tick();
  assert.equal(state().cards['w/A1'].state, 'ready');
  socket.push('still here');
  await new Promise(setImmediate);
  clock += 29 * 60_000;
  await tick();
  assert.equal(state().cards['w/A1'].state, 'ready');
  upstream.push('response');
  await new Promise(setImmediate);
  clock += 29 * 60_000;
  await tick();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const closed = new Promise((resolve) => socket.once('close', resolve));
  clock += 2 * 60_000;
  await tick();
  assert.equal(manager.lookup('orch', 'A1', { manifest }), null);
  assert.equal(state().cards['w/A1']?.state, undefined);
  assert.equal(state().cards['w/A1']?.sha, undefined);
  assert.ok(calls().includes('serve --https=8500 off'));
  await closed;
  assert.ok(upstream.destroyed);
  assert.ok(relays[0].closed);
  assert.deepEqual(thread(), []);
});

test('a port announcement followed by exit before readiness fails, even with exit 0', async () => {
  manager = createTryManager({ answers: async () => false, log() {} });
  setScript("console.log('port 32123');");
  await start();
  await until(() => thread().length === 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].text, /^Serve failed \(exit 0\)\nBuild script exited before its port answered/);
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
  await until(() => state().cards['w/A1'].state === 'ready');
  const first = state().cards['w/A1'].at;
  clock += 1000;
  await tick();
  assert.equal(state().cards['w/A1'].at, first);
  setScript('process.exit(9);');
  const failedSha = commit(worktree, 'failure');
  await tick();
  await until(() => thread().length === 1);
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
  await until(() => state().main?.state === 'ready');
  assert.deepEqual(state().main, { sha, branch: 'main', slug: 'example/project', at: git(repo, 'log', '-1', '--format=%cI'), state: 'ready', script: true });
  const dir = path.join(home, '.claude/kickflip/try/orch-main');
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
  await until(() => state().main?.state === 'failed');
  assert.equal(state().main.sha, failedSha);
  await tick();
  assert.equal(state().main.state, 'failed');
  const metadata = state().main;
  setScript('process.exit(0);', repo);
  const movedSha = commit(repo, 'origin moved');
  git(repo, 'update-ref', 'refs/remotes/origin/main', movedSha);
  await manager.stop();
  let reason = 'Try builds wait on Tailscale: Tailscale isn’t signed in';
  manager = createTryManager({ waiting: async () => reason, log() {} });
  await assert.rejects(start({ key: 'main' }), (e) => e.status === 409 && e.message === reason);
  reason = null;
  write(path.join(dir, 'hold'), '');
  assert.deepEqual(await start({ key: 'main' }), { status: 'started' });
  await assert.rejects(start({ key: 'main' }), (e) => e.status === 409 && /already running/.test(e.message));
  fs.unlinkSync(path.join(dir, 'hold'));
  await until(() => state().main.state === 'failed');
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
  await assert.rejects(start({ key: 'main' }), /already registered/);
  assert.deepEqual(state().main, metadata);
  assert.match(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8'), /already registered/);
  assert.deepEqual(thread(), []);
  git(repo, 'worktree', 'prune');
});

test('a restart clears dead web cards and stops main so the next tick serves it again', async () => {
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: { 'w/A1': { state: 'ready', port: 1 } }, main: { state: 'ready', port: 2, sha: 'old', script: true } });
  await manager.initialize(manifest);
  assert.deepEqual(state(), { kind: 'web', cards: {}, main: { sha: 'old', script: true } });
});

test('shutdown stops process groups without failure messages and refuses new starts', async () => {
  setScript('setInterval(() => {}, 1000);');
  await start();
  await manager.stop();
  assert.deepEqual(thread(), []);
  await assert.rejects(start(), /hub is stopping/);
});

test('a web script serves root paths and upgrades through the relay and keeps its port across a new commit and Retry', async () => {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  setScript(`const server = require('node:http').createServer((req, res) => res.end('served ' + req.url));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n' + req.url));
  server.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`);
  await start();
  await until(() => state().cards['w/A1'].state === 'ready');
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
  commit(worktree, 'new head');
  for (let n = 0; n < 2; n++) {
    await start();
    await until(() => state().cards['w/A1'].state === 'ready');
    assert.equal(state().cards['w/A1'].https, 8500);
    assert.equal(await (await fetch(relayOf(8500) + '/')).text(), 'served /');
  }
  await manager.stop();
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 3);
});

test('main keeps its fixed port across merges and restart, never idles out and uses the recorded branch and origin slug', async (t) => {
  const relays = fakeRelays(t);
  manager = createTryManager({ now: () => clock, answers: async () => true, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);", repo);
  const sha = commit(repo, 'web main');
  git(repo, 'update-ref', 'refs/remotes/origin/develop', sha);
  manifest.sites.orch.branch = 'develop';
  delete manifest.sites.orch.github;
  await tick();
  await until(() => state().main?.state === 'ready');
  assert.equal(state().main.slug, 'example/project');
  assert.equal(state().main.branch, 'develop');
  assert.equal(state().main_port, 8500);
  assert.equal(state().main.https, 8500);
  setScript("console.log('port 32124'); setInterval(() => {}, 1000);");
  await start();
  await until(() => state().cards['w/A1'].state === 'ready');
  assert.equal(state().cards['w/A1'].https, 8501);
  write(path.join(repo, 'file'), 'merged');
  const merged = commit(repo, 'merge');
  git(repo, 'update-ref', 'refs/remotes/origin/develop', merged);
  await tick();
  await until(() => state().main?.state === 'ready');
  assert.equal(state().main.sha, merged);
  assert.equal(state().main.https, 8500);
  clock += 60 * 60_000;
  await tick();
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32123);
  await manager.stop();
  manager = createTryManager({ now: () => clock, answers: async () => true, log() {} });
  await manager.initialize(manifest);
  assert.equal(state().main.state, undefined);
  await tick();
  await until(() => state().main?.state === 'ready');
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

test('the hub build route enforces loopback and fixed inputs', async () => {
  const free = async () => {
    const server = http.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  };
  const port = await free();
  const target = await free();
  setScript(`require('node:http').createServer((req, res) => res.end('ok')).listen(${target}, '127.0.0.1', () => console.log('port ${target}'));`);
  const web = path.join(home, '.claude/kickflip');
  write(path.join(web, 'manifest.json'), manifest);
  write(path.join(home, 'tailscale.status'), { Web: { 'mac.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });
  write(path.join(web, 'settings.json'), { polling: { windows: [{ from: '00:00', every_minutes: 120 }], hold_overnight: false, wakes: [] } });
  const hub = spawn(process.execPath, [path.join(root, 'hub/hub.mjs')], { env: { ...process.env, KICKFLIP_HUB_PORT: String(port) } });
  let errors = '';
  hub.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => hub.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      hub.stdout.on('data', (chunk) => { output += chunk; if (output.includes('hub on')) resolve(); });
      hub.once('exit', (code) => reject(new Error(`hub exited ${code}: ${errors}`)));
    });
    const post = (input, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/_hub/build', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end(JSON.stringify(input));
    });
    const input = { route: 'orch', key: 'w/A1' };
    for (const headers of [{ origin: 'https://mac.ts.net' }, { 'x-forwarded-for': '100.64.0.1' }, { host: 'mac.ts.net' }]) assert.equal(await post(input, headers), 403);
    assert.equal(await post({ ...input, command: '/bin/sh' }), 400);
    assert.equal(await post({ ...input, key: 'main' }), 409);
    assert.equal(await post(input), 202);
    await until(() => state().cards['w/A1']?.state === 'ready');
  } finally { hub.kill('SIGTERM'); await exited; }
});

test('a running script with no port fails after sixty minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setScript("require('node:fs').writeFileSync('started', 'yes'); setInterval(() => {}, 1000);");
  await start();
  await until(() => fs.existsSync(path.join(worktree, 'started')));
  t.mock.timers.tick(59 * 60_000);
  assert.equal(state().cards['w/A1'].state, 'running');
  t.mock.timers.tick(60_000);
  await until(() => thread().length === 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].text, /No port line within 60 minutes/);
  t.mock.timers.reset();
});

test('an unanswered announced port fails after sixty seconds', async () => {
  manager = createTryManager({ now: () => clock, answers: async () => false, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await until(() => fs.readFileSync(path.join(site, 'data/try/A1.log'), 'utf8').includes('port'));
  clock += 61_000;
  await until(() => thread().length === 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].text, /Nothing answered.*60 seconds/);
});

test('shutdown kills the whole process group, escalating when a server ignores SIGTERM', async () => {
  setScript(`const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => fs.writeFileSync('server.pid', String(child.pid)));
setInterval(() => {}, 1000);`);
  await start();
  await until(() => fs.existsSync(path.join(worktree, 'server.pid')));
  const pid = Number(fs.readFileSync(path.join(worktree, 'server.pid'), 'utf8'));
  await manager.stop();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(thread(), []);
});

test('an automatic validation refusal records one failed head and useful thread log, while a main failure survives restart', async () => {
  config({ auto_build: true });
  setScript('process.exit(0);');
  fs.chmodSync(script(), 0o600);
  const sha = commit(worktree, 'not executable');
  await tick();
  assert.equal(state().cards['w/A1'].sha, sha);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].text, /Serve failed \(exit 1\)\nBuild script must be executable/);
  await tick();
  assert.equal(thread().length, 1);
  setScript('process.exit(0);', repo);
  const mainSha = commit(repo, 'main script');
  git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
  await manager.stop();
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: {}, main: { sha: mainSha, state: 'failed', script: true } });
  manager = createTryManager({ log() {} });
  await manager.initialize(manifest);
  await tick();
  assert.equal(state().main.state, 'failed');
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main')), false);
});

test('startup removes only unowned in-range ports and parses stdout despite a version warning', async () => {
  write(path.join(home, 'tailscale.status'), { TCP: { 443: {}, 8499: {}, 8500: {}, 8599: {}, 8600: {} } });
  await manager.initialize(manifest);
  assert.deepEqual(calls(), ['serve status --json', 'serve --https=8500 off', 'serve --https=8599 off']);
});

test('a failed Tailscale registration fails the run with stderr and removes the port', async (t) => {
  const relays = fakeRelays(t);
  manager = createTryManager({ answers: async () => true, log() {} });
  write(path.join(home, 'tailscale.fail'), 'yes');
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await until(() => thread().length === 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(state().cards['w/A1'].https, undefined);
  assert.match(thread()[0].text, /Couldn't open try port 8500: permission denied by tailscaled/);
  assert.ok(relays[0].closed);
  assert.ok(calls().includes('serve --https=8500 off'));
  fs.rmSync(path.join(home, 'tailscale.fail'));
  setScript("require('node:fs').writeFileSync('server.pid', String(process.pid)); console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await until(() => state().cards['w/A1'].state === 'ready');
  assert.equal(state().cards['w/A1'].https, 8500);
  process.kill(Number(fs.readFileSync(path.join(worktree, 'server.pid'), 'utf8')), 'SIGTERM');
  await until(() => thread().length === 2);
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 2);
  assert.ok(relays.every((relay) => relay.closed));
});

test('card ports skip every board’s fixed main port, including closed boards, and release on idle', async (t) => {
  fakeRelays(t);
  manager = createTryManager({ now: () => clock, answers: async () => true, log() {} });
  const other = path.join(home, 'other');
  write(path.join(other, 'data/try.json'), { main_port: 8500 });
  manifest.closed = { other: { site: { dir: other } } };
  write(path.join(site, 'data/try.json'), { kind: 'web', main_port: 8501, cards: {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await until(() => state().cards['w/A1'].state === 'ready');
  assert.equal(state().cards['w/A1'].https, 8502);
  clock += 31 * 60_000;
  await tick();
  assert.ok(calls().includes('serve --https=8502 off'));
  assert.equal(state().main_port, 8501);
  write(path.join(site, 'data/agents/A2.json'), { worktree: { path: worktree, repo } });
  await start({ key: 'w/A2' });
  await until(() => state().cards['w/A2'].state === 'ready');
  assert.equal(state().cards['w/A2'].https, 8502);
  manifest.sites = {};
  await tick();
  assert.equal(calls().filter((call) => call === 'serve --https=8502 off').length, 2);
  assert.equal(state().cards['w/A2'], undefined);
});

test('exhausted try ports fail clearly without adding a serve entry', async () => {
  manager = createTryManager({ answers: async () => true, log() {} });
  manifest.closed = {};
  for (let port = 8500; port <= 8599; port++) {
    const dir = path.join(home, `reserved-${port}`);
    write(path.join(dir, 'data/try.json'), { main_port: port });
    manifest.closed[port] = { site: { dir } };
  }
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await until(() => thread().length === 1);
  assert.match(thread()[0].text, /No try ports available \(8500–8599\)/);
  assert.equal(calls().some((call) => call.includes('--bg')), false);
});

test('startup cleanup failure logs and still allows a build', async () => {
  const logs = [];
  manager = createTryManager({ log: (line) => logs.push(line) });
  write(path.join(home, 'tailscale.status'), 'not json');
  await manager.initialize(manifest);
  assert.match(logs[0], /try startup cleanup/);
  setScript('process.exit(0);');
  await start();
  await until(() => state().cards['w/A1'].state === 'ready');
});

test('try builds refuse with 409 while waiting and main rebuilds wait without a failure', async () => {
  const reason = 'Try builds wait on Tailscale: Tailscale / is not serving the hub.';
  const launched = path.join(home, 'build-started');
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`);
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`, repo);
  commit(repo);
  const messages = [];
  manager = createTryManager({ waiting: async () => reason, log: (text) => messages.push(text) });
  await assert.rejects(start(), (error) => error.status === 409 && error.message === reason);
  await tick();
  assert.equal(fs.existsSync(launched), false);
  assert.equal(state().main, null);
  assert.equal(Object.values(state().cards).some((card) => card.state === 'failed' || card.state === 'running'), false);
  assert.deepEqual(thread(), []);
  assert.deepEqual(messages, []);
});
