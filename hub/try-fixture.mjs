// Shared by hub/try.test.mjs and the hub/try-*.test.mjs files: a scratch home with stand-in tools, a board in a git repo with a
// card worktree, and a try manager over it, made fresh for each test.
import { home, bin, inProcessHub } from './hub-fixture.mjs';
import { beforeEach, afterEach } from 'node:test';
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
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
export const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
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
  // tailscale.node, when written, is the node this daemon answers as.
  const node = path.join(process.env.HOME, 'tailscale.node');
  console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.ts.net.', HostName: 'mac', ...(fs.existsSync(node) && { ID: fs.readFileSync(node, 'utf8') }) } }));
} else if (args.join(' ') === 'debug prefs') {
  console.log(JSON.stringify({ OperatorUser: require('node:os').userInfo().username }));
} else if (args.includes('--bg') && fs.existsSync(path.join(process.env.HOME, 'tailscale.fail'))) {
  console.error('permission denied by tailscaled'); process.exit(1);
} else if (args[0] === 'serve' && args.some((a) => a.startsWith('--https='))) {
  // The serve config keeps what serve --bg sets and off removes, as tailscaled does.
  // Calls that run at once take turns on the file, as tailscaled's one config does.
  const file = path.join(process.env.HOME, 'tailscale.status');
  const lock = file + '.lock';
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = args.find((a) => a.startsWith('--https=')).slice('--https='.length);
    config.TCP ||= {}; config.Web ||= {};
    if (args.at(-1) === 'off') { delete config.TCP[port]; delete config.Web['mac.ts.net:' + port]; }
    else { config.TCP[port] = { HTTPS: true }; config.Web['mac.ts.net:' + port] = { Handlers: { '/': { Proxy: args.at(-1) } } }; }
    fs.writeFileSync(file + '.next', JSON.stringify(config));
    fs.renameSync(file + '.next', file);
  } finally { fs.rmdirSync(lock); }
}
`);
fs.chmodSync(path.join(bin, 'tailscale'), 0o700);
// Without the pick's daemon check, which runs when this Mac has its own tailscale on PATH too.
export const calls = () => fs.readFileSync(path.join(home, 'tailscale.calls'), 'utf8').trim().split('\n').filter((call) => call && call !== 'status --json');
export const relayOf = (port) => calls().filter((call) => call.startsWith(`serve --bg --https=${port} `)).at(-1)?.split(' ').at(-1);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.KICKFLIP_TAILSCALE = path.join(bin, 'tailscale');
export const { createTryManager, installWorktree, fetchTryBranches: fetchTimed } = await import('./try.mjs');
// The manager and the poll run each command as they would, without its time limit, so a slow host only slows a test.
export const execFileAsync = promisify(execFile);
export const untimed = (command, args, { timeout: _limit, ...options } = {}) => execFileAsync(command, args, options);
// A runner whose ps and lsof list only the given processes ({pid, pgid, command, cwd}), as a host would, and that runs
// every other command untimed.
export const listing = (processes) => async (command, args, options) => {
  if (command === 'ps') return { stdout: processes.map((p) => `${p.pid} ${p.pgid} ${p.command}`).join('\n') + '\n' };
  if (command === 'lsof') return { stdout: processes.map((p) => `p${p.pid}\nn${p.cwd}`).join('\n') + '\n' };
  return untimed(command, args, options);
};
// A test's manager sees only the processes it lists, none unless it passes its own run. Its tailnet is on unless the test
// says otherwise, and its relays take any free port, so test files running at once and the host's own hub never meet on
// a try port. Its relays take every request as a signed-in device's, unless the test passes its own signedIn.
export const tryManager = (options = {}) => createTryManager({ run: listing([]), tailnet: () => true, relayPort: () => 0, signedIn: () => true, ...options });
export const fetchTryBranches = (options = {}) => fetchTimed({ run: untimed, ...options });
// → a port nothing on 127.0.0.1 listens on now.
export async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
// → the body a GET of url answers, on a connection of its own, so no kept-alive socket reaches a relay that has closed.
export const visit = (url) => new Promise((resolve, reject) => {
  http.get(url, { agent: false }, (res) => { let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve(body)); }).on('error', reject);
});
let signalCount = 0;
// A unix socket a script signals the test through: the script runs signal(path, text), and next() resolves with the
// next signal's {text, closed}, closed resolving once the process that sent it has ended.
export async function signals() {
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
export const signal = (socket, text) => `require('node:net').connect(${JSON.stringify(socket.path)}).write(${JSON.stringify(text + '\n')});`;
// A port probe for the manager that answers while up() holds, and whose asked(port) resolves at the manager's first
// probe of port, which it makes once the script's port line is read.
export function prober(up = () => true) {
  const asks = new Map();
  const askOf = (port) => {
    if (!asks.has(port)) { let resolve; asks.set(port, { promise: new Promise((r) => { resolve = r; }), resolve }); }
    return asks.get(port);
  };
  return { answers: async (port) => { askOf(port).resolve(); return up(port); }, asked: (port) => askOf(port).promise };
}
export const { listBoards } = await import('./boards.mjs');
export const { buildScriptError } = await import('../board/build-script.mjs');
export const { ownerGate } = await import('../board/on-host.mjs');
export let site, repo, worktree, manifest, manager, clock;
export const setManager = (next) => { manager = next; };
export const advance = (ms) => { clock += ms; };
export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
export const script = () => path.join(worktree, '.kickflip', 'build');
export const setScript = (body, dir = worktree) => {
  const file = path.join(dir, '.kickflip', 'build');
  write(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o700);
};
export const state = () => read(path.join(site, 'data', 'try.json'));
export const thread = () => { try { return fs.readFileSync(path.join(site, 'data', 'threads', 'w__A1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
export const start = (input = {}) => manager.start({ route: 'orch', key: 'w/A1', ...input }, { manifest });
export const tick = () => manager.tick({ manifest });
export const kill = (key = 'w/A1') => manager.kill({ route: 'orch', key }, { manifest });
export const until = (fn) => waitUntil(fn, 'timed out waiting for try state');
export const config = (extra = {}) => write(path.join(site, 'board.json'), { items: 'data/items.json', slug: 'w', ...extra });
export function commit(dir, name = 'change') { git(dir, 'add', '.'); git(dir, 'commit', '--quiet', '-m', name); return git(dir, 'rev-parse', 'HEAD'); }

export function fakeRelays(t) {
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

