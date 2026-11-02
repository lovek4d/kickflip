import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
const state = path.join(home, '.claude', 'kickflip');
const bin = path.join(home, 'bin');
const [port, pagePort, learnPort] = await freePorts(3);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', PATH: `${bin}:${process.env.PATH}` };
const manifest = () => JSON.parse(fs.readFileSync(path.join(state, 'manifest.json'), 'utf8')).sites;
const sidebar = async () => (await (await fetch(`${base}/_hub/sidebar.json?fresh=1`)).json()).sites;
const row = async (route) => (await sidebar()).find((s) => s.route === route);
const cli = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'kickflip.mjs'), ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
});

let hub;
let page;
const asked = [];

before(async () => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tailscale'), '#!/bin/sh\necho \'{"Self":{"DNSName":"mac.tail.ts.net."}}\'\n');
  fs.chmodSync(path.join(bin, 'tailscale'), 0o755);
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

test('join --port puts a server the session runs at /<route> under Pages with no owner, watcher or needs, and it reads Down once that server stops', async () => {
  const r = await cli('join', 'notes', '--port', String(pagePort), '--title', 'Notes');
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
  assert.match((await row('notes')).sub, /Down/);
  const down = await fetch(`${base}/notes/`);
  assert.equal(down.status, 502);
  assert.match(await down.text(), /nothing answers on port/);
  page = http.createServer((req, res) => res.end('back')).listen(pagePort, '127.0.0.1');
  await until(async () => (await row('notes')).state === 'up', 'notes comes back up');
});

test('join --dir has the hub serve the folder with the route stripped, never a dot file, and a rejoin keeps how it is served', async () => {
  const folder = path.join(home, 'course');
  fs.mkdirSync(path.join(folder, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Course</h1>');
  fs.writeFileSync(path.join(folder, 'lessons', 'one.html'), '<h1>One</h1>');
  fs.writeFileSync(path.join(folder, '.env'), 'SECRET=1');
  const r = await cli('join', 'course', '--dir', folder);
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

  assert.equal((await cli('join', 'course', '--title', 'Sync course')).status, 0);
  assert.deepEqual([manifest().course.dir, manifest().course.title], [folder, 'Sync course']);
  assert.equal((await cli('join', 'nothing')).status, 2);
  assert.equal((await cli('join', 'missing', '--dir', path.join(home, 'nope'))).status, 2);
});

test('--watch with --session is today\'s join: the starter kit, the owner, the watcher and the Needs you badge; a plain join refuses that route', async () => {
  assert.match((await cli('join', 'learn', '--watch')).stderr, /--watch needs --session/);
  const r = await cli('join', 'learn', '--session', 's-learn', '--watch', '--title', 'Learn', '--port', String(learnPort));
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

  assert.equal((await cli('join', 'learn', '--session', 's-learn', '--watch', 'data/a.jsonl,data/b.jsonl')).status, 0);
  assert.deepEqual(manifest().learn.watch, ['data/a.jsonl', 'data/b.jsonl']);
  const taken = await cli('join', 'learn', '--port', String(pagePort));
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
