import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
const state = path.join(home, '.claude', 'kickflip');
const bin = path.join(home, 'bin');
const [port, pagePort, learnPort] = await freePorts(3);
const base = `http://127.0.0.1:${port}`;
const claudeConfig = path.join(home, 'claude-config');
// A stand-in tmux for join --hub: logs each call; has-session finds none, and attach-session prints its target.
const fakeTmux = path.join(bin, 'tmux');
const tmuxLog = path.join(home, 'tmux-calls.jsonl');
const tmuxCalls = () => (fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeConfig, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: fakeTmux, TMUX: '', PATH: `${bin}:${process.env.PATH}` };
// A stand-in claude for kickflip join: it logs each call, and a --bg start prints its id and leaves a session record.
const fakeClaude = path.join(bin, 'claude');
const claudeLog = path.join(home, 'claude-calls.jsonl');
const claudeCalls = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const manifest = () => JSON.parse(fs.readFileSync(path.join(state, 'manifest.json'), 'utf8')).sites;
const sidebar = async () => (await (await fetch(`${base}/_hub/sidebar.json?fresh=1`)).json()).sites;
const row = async (route) => (await sidebar()).find((s) => s.route === route);
const cliIn = (cwd, args, more = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'kickflip.mjs'), ...args], { cwd, env: { ...env, KICKFLIP_CLAUDE: fakeClaude, ...more } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
});
const cli = (...args) => cliIn(home, args);
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function gitRepo(name, origin) {
  const dir = path.join(home, 'dev', name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return fs.realpathSync(dir);
}

let hub;
let page;
const asked = [];

before(async () => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tailscale'), '#!/bin/sh\necho \'{"BackendState":"Running","Self":{"DNSName":"mac.tail.ts.net."}}\'\n');
  fs.chmodSync(path.join(bin, 'tailscale'), 0o755);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
if (!argv.includes('--bg')) process.exit(0);
const id = require('node:crypto').randomUUID();
const sessions = ${JSON.stringify(path.join(home, '.claude', 'sessions'))};
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(sessions + '/fake-' + id + '.json', JSON.stringify({ pid: 999999, sessionId: id, jobId: id.slice(0, 8), kind: 'bg' }));
console.log('backgrounded · ' + id.slice(0, 8) + ' · board');
`);
  fs.chmodSync(fakeClaude, 0o755);
  fs.writeFileSync(fakeTmux, `#!${process.execPath}
const argv = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(tmuxLog)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'attach-session') console.log('attached ' + argv[2]);
process.exit(argv[0] === 'has-session' ? 1 : 0);
`);
  fs.chmodSync(fakeTmux, 0o755);
  fs.mkdirSync(claudeConfig, { recursive: true });
  fs.writeFileSync(path.join(claudeConfig, '.claude.json'), JSON.stringify({ theme: 'dark' }));
  page = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`page saw ${req.url}`);
  });
  await new Promise((resolve) => page.listen(pagePort, '127.0.0.1', resolve));
  hub = spawn(process.execPath, [path.join(ROOT, 'hub', 'hub.mjs')], { env });
  await new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
});

after(async () => {
  page?.close();
  if (hub && hub.exitCode === null && hub.signalCode === null) {
    const exited = new Promise((resolve) => hub.once('exit', resolve));
    hub.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('join --port puts a server the session runs at /<route> under Pages with no owner, watcher or needs, and it reads down once that server stops', async () => {
  const r = await cli('join', '--name', 'Notes', '--port', String(pagePort));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json(), { route: 'notes', url: 'https://mac.tail.ts.net/notes/', serves: 'port', port: pagePort, answering: true, hub: 'running' });
  const entry = manifest().notes;
  assert.deepEqual(Object.keys(entry).sort(), ['created', 'port', 'title', 'updated']);

  assert.equal(await (await fetch(`${base}/notes/a/b?x=1`)).text(), 'page saw /a/b?x=1');
  const load = await fetch(`${base}/notes/`, { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(load.headers.get('x-app-shell'), '1');
  await until(async () => (await row('notes'))?.state === 'up', 'notes reads up');
  assert.deepEqual(await row('notes').then(({ board, count }) => ({ board, count })), { board: false, count: 0 });
  assert.ok(!asked.some((u) => u.startsWith('/_claude/')), asked.join(', '));

  const closed = new Promise((resolve) => page.close(resolve));
  page.closeAllConnections();
  await closed;
  await until(async () => (await row('notes')).state === 'down', 'notes reads down');
  assert.match((await row('notes')).sub, />down</);
  const down = await fetch(`${base}/notes/`);
  assert.equal(down.status, 502);
  assert.match(await down.text(), /nothing answers on port/);
  page = http.createServer((req, res) => res.end('back')).listen(pagePort, '127.0.0.1');
  await until(async () => (await row('notes')).state === 'up', 'notes comes back up');
});

test('join --dir has the hub serve the folder with the route stripped, never a dot file, and a rejoin by its route keeps the title', async () => {
  const folder = path.join(home, 'course');
  fs.mkdirSync(path.join(folder, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Course</h1>');
  fs.writeFileSync(path.join(folder, 'lessons', 'one.html'), '<h1>One</h1>');
  fs.writeFileSync(path.join(folder, '.env'), 'SECRET=1');
  const r = await cli('join', '--name', 'Course', '--dir', folder);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json(), { route: 'course', url: 'https://mac.tail.ts.net/course/', serves: 'files', dir: folder, hub: 'running' });
  assert.equal(manifest().course.port, undefined);

  const frame = await fetch(`${base}/course/`, { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(await frame.text(), '<h1>Course</h1>');
  assert.match(frame.headers.get('content-type'), /text\/html/);
  assert.equal(await (await fetch(`${base}/course/lessons/one.html?from=1`)).text(), '<h1>One</h1>');
  const slash = await fetch(`${base}/course/lessons?x=1`, { redirect: 'manual' });
  assert.deepEqual([slash.status, slash.headers.get('location')], [301, '/course/lessons/?x=1']);
  assert.equal((await fetch(`${base}/course/.env`)).status, 404);
  assert.equal((await fetch(`${base}/course/lessons/two.html`)).status, 404);
  assert.equal((await fetch(`${base}/course/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/course/`, { headers: { 'sec-fetch-dest': 'document' } })).headers.get('x-app-shell'), '1');
  assert.equal((await row('course')).state, 'up');

  assert.equal((await cli('join', '--name', 'course', '--dir', folder, '--description', 'Lessons')).status, 0);
  assert.deepEqual([manifest().course.dir, manifest().course.title, manifest().course.description], [folder, 'Course', 'Lessons']);
  const route = await cli('join', 'course', '--dir', folder);
  assert.deepEqual([route.status, route.stderr], [2, 'kickflip: join takes no route: --name "<name>" gives the title and the route, as in kickflip join --name course\n']);
  assert.match((await cli('join', '--name', 'course', '--dir', folder, '--title', 'Sync')).stderr, /join takes no --title/);
  assert.equal((await cli('join', '--name', '!!', '--dir', folder)).status, 2);
  assert.equal((await cli('join', '--name', 'missing', '--dir', path.join(home, 'nope'))).status, 2);
});

test('--watch with --session is today\'s join: the starter kit, the owner, the watcher and the Needs you badge; a plain join refuses that route', async () => {
  assert.match((await cli('join', '--name', 'learn', '--watch')).stderr, /--watch needs --session/);
  const r = await cli('join', '--name', 'Learn', '--session', 's-learn', '--watch', '--port', String(learnPort));
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.url, 'https://mac.tail.ts.net/learn/');
  assert.equal(out.createdFromStarter, true);
  assert.match(out.watcher, /wait-events\.mjs learn s-learn$/);
  const entry = manifest().learn;
  assert.deepEqual([entry.owner.session, entry.watch, entry.cmd.at(-1)], ['s-learn', ['data/events.jsonl'], path.join(state, 'sites', 'learn', 'server.mjs')]);

  await until(() => fetch(`${base}/learn/_claude/health`).then((x) => x.ok, () => false), 'the hub runs the starter server');
  fs.mkdirSync(path.join(state, 'sites', 'learn', 'data'), { recursive: true });
  fs.writeFileSync(path.join(state, 'sites', 'learn', 'data', 'needs.json'), JSON.stringify({ items: [{ kind: 'Question', text: 'Which?', url: '#q' }] }));
  await until(async () => (await row('learn'))?.count === 1, 'learn badges one need');

  assert.equal((await cli('join', '--name', 'learn', '--session', 's-learn', '--watch', 'data/a.jsonl,data/b.jsonl')).status, 0);
  assert.deepEqual([manifest().learn.watch, manifest().learn.title], [['data/a.jsonl', 'data/b.jsonl'], 'Learn']);
  const taken = await cli('join', '--name', 'learn', '--port', String(pagePort));
  assert.equal(taken.status, 3);
  assert.equal(manifest().learn.owner.session, 's-learn');
});

test('leave takes a plain page off without a session, and still asks for the owning session on a watched site', async () => {
  const r = await cli('leave', 'course');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(manifest().course, undefined);
  assert.ok(fs.existsSync(path.join(home, 'course', 'index.html')));
  assert.equal((await fetch(`${base}/course/`)).status, 404);
  assert.equal(await row('course'), undefined);

  assert.equal((await cli('leave', 'learn')).status, 2);
  assert.equal((await cli('leave', 'learn', '--session', 's-other')).status, 3);
  assert.equal((await cli('leave', 'learn', '--session', 's-learn')).status, 0);
  await until(() => fetch(`${base}/learn/_claude/health`).then((x) => !x.ok, () => true), 'the hub stops the starter server');
  assert.equal((await cli('leave', 'notes')).status, 0);
  assert.deepEqual(Object.keys(manifest()), []);
});

test('kickflip join refuses a folder outside git, says to run kickflip init while the hub is down, and needs --name with no terminal to ask in', async () => {
  const plain = path.join(home, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const outside = await cliIn(plain, ['join']);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /is not in a git repo/);
  const repo = gitRepo('idle');
  const [down] = await freePorts(1);
  const noHub = await cliIn(repo, ['join', '--name', 'Idle'], { KICKFLIP_HUB_PORT: String(down) });
  assert.deepEqual([noHub.status, noHub.stderr], [1, 'kickflip: the hub is not running; run kickflip init to set it up, then kickflip join here again\n']);
  const unnamed = await cliIn(repo, ['join']);
  assert.deepEqual([unnamed.status, unnamed.stderr], [2, 'kickflip: join needs --name "<Board name>" when it has no terminal to ask in\n']);
  for (const name of ['Idle-app', 'Idle!', '  ']) {
    const r = await cliIn(repo, ['join', '--name', name]);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, /A board name takes letters, digits and spaces/);
  }
  assert.equal((await cliIn(repo, ['join', '--name', 'Idle', '--watch'])).status, 2);
  assert.deepEqual([Object.keys(manifest()), claudeCalls()], [[], []]);
});

test('kickflip join in a repo makes a local board named as asked, with its GitHub origin and branch, trusts the folder and starts its session in the background', async () => {
  const repo = gitRepo('my_app', 'git@github.com:owner/my-app.git');
  git(repo, 'checkout', '--quiet', '-b', 'trunk');
  const r = await cliIn(path.join(repo, 'src'), ['join', '--name', 'My  app']);
  assert.equal(r.status, 0, r.stderr);
  const entry = manifest()['my-app'];
  const [call] = claudeCalls();
  assert.deepEqual([call.cwd, call.argv[0], call.argv.at(-1)], [repo, '--bg', "/kickflip --name 'My app' --template board --items data/items.json"]);
  const [record] = fs.readdirSync(path.join(home, '.claude', 'sessions'));
  const { sessionId: session } = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', record), 'utf8'));
  assert.deepEqual(
    [entry.title, entry.github, entry.branch, entry.local, entry.watch, entry.owner.repo, entry.owner.session, entry.owner.label],
    ['My app', 'owner/my-app', 'trunk', true, ['data/events.jsonl'], repo, session, 'My app'],
  );
  assert.deepEqual(entry.cmd.slice(1), [path.join(ROOT, 'board', 'server.mjs'), path.join(state, 'sites', 'my-app')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'sites', 'my-app', 'board.json'), 'utf8')), { title: 'My app', items: 'data/items.json' });
  const wave = JSON.parse(fs.readFileSync(path.join(state, 'sites', 'my-app', 'data', 'items.json'), 'utf8'));
  assert.equal(wave.title, 'My app');
  assert.deepEqual(wave.items.map((i) => [i.id, i.phase, i.ticket, i.plan]), [
    ['T-1', 'grilling', undefined, 'T-1-notes.md'],
    ['T-2', 'grilling', undefined, 'T-2-notes.md'],
  ]);
  assert.match(fs.readFileSync(path.join(state, 'sites', 'my-app', 'data', 'T-1-notes.md'), 'utf8'), /^# Prepare \.kickflip\/build/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeConfig, '.claude.json'), 'utf8')), { theme: 'dark', projects: { [repo]: { hasTrustDialogAccepted: true } } });
  assert.equal(r.stdout, `Made My app at https://mac.tail.ts.net/my-app/, working in ${repo} (owner/my-app).\nIts session is starting in the background, and joins the board shortly.\n`);

  const rejoin = await cliIn(repo, ['join', '--name', 'My app', '--session', session]);
  assert.equal(rejoin.status, 0, rejoin.stderr);
  assert.deepEqual([manifest()['my-app'].local, manifest()['my-app'].github, manifest()['my-app'].owner.repo], [true, 'owner/my-app', repo]);
  const again = await cliIn(repo, ['join']);
  assert.deepEqual([again.status, again.stdout], [1, 'This folder already has a board: My app (/my-app).\n']);
  assert.match(again.stderr, /Run kickflip join in a terminal to restart its session/);
  const other = gitRepo('other app');
  const taken = await cliIn(other, ['join', '--name', 'my app']);
  assert.deepEqual([taken.status, taken.stderr], [2, 'kickflip: /my-app is taken; pick another name.\n']);
  assert.equal(claudeCalls().length, 1);
});

test('a board for a repo whose main already has a build script starts without the build to-do', async () => {
  const repo = gitRepo('built app');
  fs.mkdirSync(path.join(repo, '.kickflip'));
  fs.writeFileSync(path.join(repo, '.kickflip', 'build-web'), '#!/bin/sh\necho port 3000\n', { mode: 0o755 });
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'build');
  const r = await cliIn(repo, ['join', '--name', 'Built app']);
  assert.equal(r.status, 0, r.stderr);
  const wave = JSON.parse(fs.readFileSync(path.join(state, 'sites', 'built-app', 'data', 'items.json'), 'utf8'));
  assert.deepEqual(wave.items.map((i) => [i.id, i.ticket]), [['T-1', undefined]]);
  assert.match(fs.readFileSync(path.join(state, 'sites', 'built-app', 'data', 'T-1-notes.md'), 'utf8'), /^# Write CONTEXT\.md/);
});

test("kickflip join records origin's default branch over the checked-out one, and running it again picks up a renamed default", async () => {
  const repo = gitRepo('legacy', 'git@github.com:owner/legacy.git');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
  git(repo, 'checkout', '--quiet', '-b', 'feature');
  const r = await cliIn(repo, ['join', '--name', 'Legacy']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(manifest().legacy.branch, 'master');

  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const again = await cliIn(repo, ['join']);
  assert.deepEqual([again.status, again.stdout], [1, 'This folder already has a board: Legacy (/legacy).\nIts branch is now trunk (it was master).\n']);
  assert.equal(manifest().legacy.branch, 'trunk');
  const same = await cliIn(repo, ['join']);
  assert.deepEqual([same.status, same.stdout], [1, 'This folder already has a board: Legacy (/legacy).\n']);
});

test('kickflip join --hub in a repo with no origin makes the hub board with no GitHub repo, starts its session in tmux and attaches this terminal', async () => {
  const repo = gitRepo('second');
  const claudeBefore = claudeCalls().length;
  const r = await cliIn(repo, ['join', '--name', 'Second', '--hub']);
  assert.equal(r.status, 0, r.stderr);
  const entry = manifest().second;
  assert.deepEqual([entry.hub, entry.local, entry.github, entry.branch, entry.owner], [true, true, undefined, 'main', { repo }]);
  const calls = tmuxCalls();
  assert.deepEqual(calls.map((argv) => argv.slice(0, 6)), [['has-session', '-t', '=kickflip-second'], ['new-session', '-d', '-s', 'kickflip-second', '-c', repo], ['attach-session', '-t', '=kickflip-second']]);
  const argv = calls[1].slice(calls[1].indexOf(fakeClaude) + 1);
  assert.equal(argv.includes('--bg'), false);
  assert.ok(argv.at(-1).startsWith("/kickflip --name 'Second' --hub\n"), argv.at(-1));
  assert.equal(claudeCalls().length, claudeBefore);
  assert.match(r.stdout, /It is the hub board, so its session runs in tmux, attached here\.\nattached =kickflip-second\n$/);
});
