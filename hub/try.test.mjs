import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { until as waitUntil } from '../shared/test-helpers.mjs';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'try-')));
process.env.HOME = home;
// The temp HOME hides the user's git identity, so the test repos' commits and merges get one here.
fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
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
} else if (args.join(' ') === 'debug prefs') {
  console.log(JSON.stringify({ OperatorUser: require('node:os').userInfo().username }));
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
const until = (fn) => waitUntil(fn, 'timed out waiting for try state');
const config = (extra = {}) => write(path.join(site, 'board.json'), { items: 'data/wave.json', slug: 'w', ...extra });
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
  setScript(`require('node:fs').writeFileSync('called.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), board: process.env.KICKFLIP_BOARD, host: process.env.HOST, base: process.env.KICKFLIP_BASE })); console.log('stdout'); console.error('stderr');`);
  const record = fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8');
  await start();
  await until(() => state().cards['w/A1']?.state === 'ready');
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

test('a failed run writes one failure with its exit, keychain hint and last five log lines, a retry once it shows failed starts, and successful runs write no message', async (t) => {
  write(path.join(site, 'data/wave.json'), { items: [{ id: 'A1', install: { url: 'https://example.com/app.apk' } }] });
  setScript("console.error('errSecInternalComponent'); console.log('one\\ntwo\\nthree\\nfour\\nfive'); process.exit(7);");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const append = fsp.appendFile;
  t.mock.method(fsp, 'appendFile', async (file, ...args) => {
    if (String(file).includes(`${path.sep}threads${path.sep}`)) await held;
    return append(file, ...args);
  });
  await start();
  await until(() => state().cards['w/A1']?.state === 'failed');
  setScript('process.exit(0);');
  const retry = start();
  await new Promise(setImmediate);
  release();
  assert.deepEqual(await retry, { status: 'started' });
  assert.equal(thread().length, 1);
  assert.equal(thread()[0].text, 'Build failed (exit 7)\nThe login keychain must be unlocked on the host.\none\ntwo\nthree\nfour\nfive');
  await until(() => state().cards['w/A1'].state === 'ready');
  assert.equal(thread().length, 1);
});

test('a second concurrent start returns 409', async () => {
  setScript('setInterval(() => {}, 1000);');
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  await assert.rejects(start(), { status: 409 });
});

test('a web run waits for its port, uses the relay to reset idle, and removes its public port on idle', async (t) => {
  const relays = fakeRelays(t);
  const peer = () => new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
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
  const closed = new Promise((resolve) => socket.once('close', resolve));
  clock += 2 * 60_000;
  await tick();
  assert.equal(manager.lookup('orch', 'A1', { manifest }), null);
  assert.equal(state().cards['w/A1']?.state, undefined);
  assert.equal(state().cards['w/A1']?.sha, undefined);
  assert.ok(calls().includes('serve --https=8500 off'));
  await closed;
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
  assert.deepEqual(await start({ key: 'main' }), { status: 'started' });
  assert.equal(state().main.state, 'running');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), failedSha);
  await until(() => state().main.state === 'failed');
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
  await until(() => state().main?.state === 'ready');
  const dir = path.join(home, '.claude/kickflip/try/orch-main');
  assert.deepEqual(read(path.join(dir, 'ran.json')), { target: 'web', args: ['main', dir], board: 'orch', host: '127.0.0.1' });
  assert.equal(state().main.target, 'web');
  await start();
  await until(() => state().cards['w/A1']?.state === 'ready');
  assert.deepEqual(read(path.join(worktree, 'ran.json')), { target: 'web', args: ['w/A1', worktree], board: 'orch', host: '127.0.0.1' });
  config({ build_target: 'ios' });
  await tick();
  await until(() => state().main?.state === 'ready' && state().main.target === 'ios');
  assert.equal(read(path.join(dir, 'ran.json')).target, 'ios');
  assert.equal(state().main.sha, sha);
  config({ build_target: 'android' });
  await tick();
  assert.equal(state().cards['w/A1'].script, false);
  assert.equal(state().main, null);
  config();
  await tick();
  assert.equal(state().cards['w/A1'].script, false);
  await until(() => state().main?.state === 'ready');
  assert.equal(read(path.join(dir, 'ran.json')).target, 'default');
  assert.equal(state().main.target, undefined);
});

test('a restart clears dead web cards and stops main so the next tick serves it again', async () => {
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: { 'w/A1': { state: 'ready', port: 1 } }, main: { state: 'ready', port: 2, sha: 'old', script: true } });
  await manager.initialize(manifest);
  assert.deepEqual(state(), { kind: 'web', cards: {}, main: { sha: 'old', script: true } });
});

test('builds waiting on each other when the hub restarts run after it, and one that can no longer start fails in its thread', async () => {
  write(path.join(site, 'data/wave.json'), { items: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] });
  for (const id of ['A2', 'A3']) write(path.join(site, `data/agents/${id}.json`), { worktree: { path: worktree, repo } });
  const lock = path.join(home, 'xcode.lock');
  const built = path.join(home, 'built');
  const keys = ['w/A1', 'w/A2', 'w/A3'];
  setScript(`const fs = require('node:fs');
const take = () => {
  try { fs.mkdirSync(${JSON.stringify(lock)}); } catch { return setTimeout(take, 20); }
  fs.appendFileSync(${JSON.stringify(built)}, process.argv[2] + '\\n');
  setInterval(() => { if (!fs.existsSync('hold')) { fs.rmdirSync(${JSON.stringify(lock)}); process.exit(0); } }, 20);
};
take();`);
  const restart = async () => {
    await manager.stop();
    fs.rmSync(lock, { recursive: true, force: true });
    manager = createTryManager({ now: () => clock, log() {} });
    await manager.initialize(manifest);
  };
  write(path.join(worktree, 'hold'), '');
  for (const key of keys) assert.deepEqual(await start({ key }), { status: 'started' });
  await until(() => fs.existsSync(built));
  await restart();
  assert.ok(keys.every((key) => state().cards[key].state === 'running'));
  fs.unlinkSync(path.join(worktree, 'hold'));
  fs.rmSync(built);
  await tick();
  await until(() => keys.every((key) => state().cards[key]?.state === 'ready'));
  assert.deepEqual(fs.readFileSync(built, 'utf8').trim().split('\n').sort(), keys);
  assert.deepEqual(thread(), []);
  write(path.join(worktree, 'hold'), '');
  await start();
  await restart();
  fs.chmodSync(script(), 0o600);
  await tick();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].text, /^Build failed \(exit 1\)\nBuild script must be executable/);
});

test("a web script serves root paths and upgrades through the relay to the owner and the board's shared logins alone, and keeps its port across a new commit and Retry", async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
  manager = createTryManager({ now: () => clock, log() {}, gate });
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  setScript(`const server = require('node:http').createServer((req, res) => req.url === '/hold' ? res.writeHead(200).write('held') : res.end('served ' + req.url));
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
      res.on('close', () => { held.ended = true; });
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
  await until(() => theirs.ended);
  assert.equal(owners.ended, false, "the owner's response stays open");
  owners.res.destroy();
  assert.equal((await fetch(relayOf(8500) + '/nested', { headers: friend })).status, 403);
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

test("a local board's main builds the tip of its recorded branch in its folder, not a branch called main", async () => {
  git(repo, 'switch', '--quiet', '-c', 'trunk');
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'trunk script');
  git(repo, 'switch', '--quiet', 'main');
  Object.assign(manifest.sites.orch, { local: true, branch: 'trunk' });
  await tick();
  await until(() => state().main?.state === 'ready');
  assert.deepEqual([state().main.sha, state().main.branch], [sha, 'trunk']);
});

test('main keeps its fixed port across merges and restart, never idles out and uses the recorded branch and origin slug', async (t) => {
  const relays = fakeRelays(t);
  manager = createTryManager({ now: () => clock, answers: async () => true, log() {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);", repo);
  const sha = commit(repo, 'web main');
  // With no github, the board builds locally: from its folder's own develop.
  git(repo, 'branch', '--force', 'develop', sha);
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
  git(repo, 'branch', '--force', 'develop', merged);
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
  manager = createTryManager({ now: () => clock, log() {}, waiting: async () => { checks += 1; if (checks === 1) await held; return null; } });
  await manager.tick({ manifest, routes: ['elsewhere'] });
  assert.equal(checks, 0);
  const running = manager.tick({ manifest });
  await until(() => checks === 1);
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
  write(path.join(site, 'data', 'wave.json'), { items: [{ id: 'A1', lane: 'review', pushed: pushed('merged-one') }, { id: 'A2', lane: 'review', pushed: pushed('open-one') }, { id: 'A3', lane: 'review', pushed: pushed('dropped-one') }] });
  delete manifest.sites.orch.github;
  manifest.sites.orch.remote = 'git@gitlab.example.com:acme/project.git';
  await fetchTryBranches({ manifest, log() {} });
  assert.deepEqual(read(path.join(site, 'data', 'wave.json')).items.map((it) => it.lane), ['done', 'review', 'done']);
  assert.equal(thread().at(-1).text, 'merged-one is merged into main on gitlab.example.com, so this card is Done.');
  assert.equal(fs.readFileSync(path.join(site, 'data', 'threads', 'w__A3.jsonl'), 'utf8').includes('dropped-one is gone from gitlab.example.com, so this card is Done.'), true);
  git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'open-one');
  git(repo, 'push', '--quiet', 'origin', 'main');
  await fetchTryBranches({ manifest, log() {} });
  assert.equal(read(path.join(site, 'data', 'wave.json')).items[1].lane, 'done');
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
const pullEvents = () => { const events = []; manager = createTryManager({ now: () => clock, log() {}, event: async (board, kind, data) => { events.push([board.route, kind, data]); return 'e1'; } }); return events; };

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

test('only a local board with an origin pulls; a GitHub board keeps its fetch and a folder with no origin has no pull record', async () => {
  const push = originFor();
  push();
  const before = git(repo, 'rev-parse', 'main');
  delete manifest.sites.orch.local;
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(git(repo, 'rev-parse', 'main'), before);
  manifest.sites.orch.local = true;
  git(repo, 'remote', 'remove', 'origin');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull, undefined);
});

test('the pull reads running while it fetches, which a restart clears', async () => {
  originFor();
  pullEvents();
  let pulling;
  await withFetchGit('sleep 0.6', async () => {
    pulling = manager.pullMains({ manifest });
    await until(() => fs.existsSync(path.join(site, 'data', 'try.json')) && state().pull?.running === true);
    await pulling;
  });
  assert.equal(state().pull.running, undefined);
  const record = { ...state(), pull: { at: 'earlier', running: true } };
  write(path.join(site, 'data', 'try.json'), record);
  await manager.stop();
  manager = createTryManager({ now: () => clock, log() {} });
  await manager.initialize(manifest);
  assert.deepEqual(state().pull, { at: 'earlier' });
});

test("a tap pulls now and rebuilds Main only when the pull brought commits; it refuses a board that isn't local", async () => {
  setScript('process.exit(0);', repo);
  commit(repo, 'script');
  const push = originFor();
  pullEvents();
  await manager.tick({ manifest });
  await until(() => state().main?.state === 'ready');
  const built = state().main.sha;
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 0 });
  assert.equal(state().main.sha, built);
  const tip = push();
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 1 });
  await until(() => state().main?.sha === tip && state().main.state === 'ready');
  write(path.join(repo, 'file'), 'edited here');
  push('again');
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 0, error: 'can’t pull: local changes' });
  await assert.rejects(manager.pull({ route: 'orch', key: 'x' }, { manifest }), { status: 400 });
  await assert.rejects(manager.pull({ route: 'nope' }, { manifest }), { status: 404 });
  delete manifest.sites.orch.local;
  await assert.rejects(manager.pull({ route: 'orch' }, { manifest }), { status: 409 });
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
  write(path.join(web, 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false } });
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
    const pull = (body, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/_hub/pull', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end(JSON.stringify(body));
    });
    for (const headers of [{ origin: 'https://mac.ts.net' }, { 'x-forwarded-for': '100.64.0.1' }, { host: 'mac.ts.net' }]) assert.equal(await pull({ route: 'orch' }, headers), 403);
    assert.equal(await pull({ route: 'orch', key: 'main' }), 400);
    assert.equal(await pull({ route: 'orch' }), 409);
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

test('shutdown kills the whole process group, escalating when a server ignores SIGTERM, with no failure message, and refuses new starts', async () => {
  setScript(`const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => fs.writeFileSync('server.pid', String(child.pid)));
setInterval(() => {}, 1000);`);
  await start();
  await until(() => fs.existsSync(path.join(worktree, 'server.pid')));
  const pid = Number(fs.readFileSync(path.join(worktree, 'server.pid'), 'utf8'));
  await manager.stop();
  // The server ignores SIGTERM, so it is gone only once the SIGKILL escalation reached it; a loaded host can take past
  // stop's own wait to reap it.
  await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }, 'the server that ignores SIGTERM was never killed');
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

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
test("the board's base prototype worktree is served while an open question links a served round: never idle, back after a restart, stopped once resolved, and a failure waits for Try again", async (t) => {
  fakeRelays(t);
  manager = createTryManager({ now: () => clock, answers: async () => true, log() {} });
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
  await until(() => state().prototypes?.state === 'ready');
  assert.equal(state().prototypes.https, 8500);
  clock += 2 * 60 * 60_000;
  await tick();
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32125);
  await manager.stop();
  manager = createTryManager({ now: () => clock, answers: async () => true, log() {} });
  await manager.initialize(manifest);
  assert.ok(!state().prototypes?.state);
  await tick();
  await until(() => state().prototypes?.state === 'ready');
  round({ resolved: '2026-11-06T10:00:00Z' });
  await tick();
  assert.ok(!state().prototypes);
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }), null);
  round();
  setScript('process.exit(3);', base);
  await tick();
  await until(() => state().prototypes?.state === 'failed');
  setScript("console.log('port 32126'); setInterval(() => {}, 1000);", base);
  await tick();
  assert.equal(state().prototypes.state, 'failed');
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  await until(() => state().prototypes?.state === 'ready');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32126);
  assert.match(fs.readFileSync(path.join(site, 'data', 'try', 'prototypes.log'), 'utf8'), /port 32126/);
  assert.deepEqual(thread(), []);
});
