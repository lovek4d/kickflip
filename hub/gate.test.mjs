// docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md
// docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md
// docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts } from '../shared/test-helpers.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const STATUS = { BackendState: 'Running', Self: { UserID: 7, TailscaleIPs: ['100.81.98.101'], DNSName: 'studio.tail1234.ts.net.' }, User: { 7: { LoginName: 'lovek4d@github', DisplayName: 'Love' } } };
const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github' };
const friend = { 'x-forwarded-for': '100.70.1.3', 'tailscale-user-login': 'friend@github' };
const tagged = { 'x-forwarded-for': '100.70.1.4' };
const html = { accept: 'text/html,application/xhtml+xml' };

// A hub on a temp HOME whose tailscale answers `status --json` from <home>/tailscale.status (failing while it's
// missing) and logs each call, beside a site whose server answers requests and upgrades with their path. board: a
// board.json for a board site /orch, whose stand-in server (a board/server.mjs under the temp HOME) answers the same way.
async function startHub(t, { status, board }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')));
  const [port] = await freePorts(1);
  for (const tool of ['gh', 'launchctl', 'systemctl', 'codex', 'caffeinate', 'claude', 'tmux']) { write(path.join(home, 'bin', tool), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(home, 'bin', tool), 0o755); }
  write(path.join(home, 'bin', 'tailscale'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(path.join(process.env.HOME, 'tailscale.calls'), args + '\\n');
const file = path.join(process.env.HOME, 'tailscale.status');
if (args !== 'status --json' || !fs.existsSync(file)) process.exit(1);
console.log(fs.readFileSync(file, 'utf8'));
`);
  fs.chmodSync(path.join(home, 'bin', 'tailscale'), 0o755);
  if (status) write(path.join(home, 'tailscale.status'), status);
  const app = http.createServer((req, res) => res.end('app ' + req.url));
  app.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n' + req.url));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const sites = { app: { port: app.address().port, title: 'App' } };
  if (board) {
    const dir = path.join(home, 'orch');
    write(path.join(dir, 'board.json'), board);
    write(path.join(home, 'stand-in', 'board', 'server.mjs'), `import http from 'node:http';
const server = http.createServer((req, res) => res.end('orch ' + req.method + ' ' + req.url + (req.method === 'POST' ? ' from ' + (req.headers['x-kickflip-shared'] || 'the owner') : '')));
server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n' + req.url));
server.listen(Number(process.env.PORT), '127.0.0.1');
`);
    const [boardPort] = await freePorts(1);
    sites.orch = { port: boardPort, title: 'Orch', dir, cmd: [process.execPath, path.join(home, 'stand-in', 'board', 'server.mjs')] };
  }
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites });
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` } });
  t.after(async () => {
    hub.kill();
    await new Promise((resolve) => hub.once('exit', resolve));
    await new Promise((resolve) => app.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
  const statusAsks = () => { try { return fs.readFileSync(path.join(home, 'tailscale.calls'), 'utf8').split('\n').filter((l) => l === 'status --json').length; } catch { return 0; } };
  return { base: `http://127.0.0.1:${port}`, home, statusAsks };
}

// → the raw response head and body to an upgrade request
const upgrade = (base, pathname, headers) => new Promise((resolve, reject) => {
  const request = http.request(base + pathname, { headers: { connection: 'Upgrade', upgrade: 'test', ...headers } });
  request.on('error', reject);
  request.on('response', (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  request.on('upgrade', (res, socket, head) => {
    let body = head.toString();
    socket.on('data', (chunk) => { body += chunk; });
    socket.on('end', () => { socket.destroy(); resolve({ status: res.statusCode, body }); });
    socket.on('error', reject);
  });
  request.end();
});

test('every hub path answers only the owner: the Mac, loopback callers and devices signed in as its user', async (t) => {
  const { base, statusAsks } = await startHub(t, { status: STATUS });
  // Loopback callers (the CLI, hooks, builders) and the owner's phone through tailscale serve.
  assert.equal((await fetch(`${base}/_hub/status.json`)).status, 200);
  assert.equal(await (await fetch(`${base}/app/x`)).text(), 'app /x');
  for (const p of ['/_hub/status.json', '/_hub/needs.json', '/_hub/api/hub', '/sw.js', '/manifest.webmanifest', '/_hub/kickflip.png']) {
    assert.equal((await fetch(base + p, { headers: phone })).status, 200, p);
  }
  assert.equal(await (await fetch(`${base}/app/x`, { headers: phone })).text(), 'app /x');
  assert.equal(statusAsks(), 1, "the owner's login is read once and kept");

  // Anyone else, on any path, gets the same refusal: a page in a browser, an empty JSON body otherwise.
  for (const headers of [friend, tagged]) {
    for (const p of ['/', '/_hub/', '/app/', '/app/x', '/nowhere/at/all', '/sw.js', '/_hub/kickflip.png']) {
      const page = await fetch(base + p, { headers: { ...headers, ...html } });
      assert.equal(page.status, 403, p);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      const text = await page.text();
      assert.match(text, /<p class="rf-line">This kickflip belongs to someone else\.<\/p>/);
      assert.match(text, /<p class="rf-sub">Ask its owner to share it with you\.<\/p>/);
      assert.match(text, /<img class="rf-mark" src="data:image\/png;base64,/);
      assert.doesNotMatch(text, /\bApp\b|\/app|lovek4d/);
    }
    for (const [method, p] of [['GET', '/_hub/api/hub'], ['GET', '/app/api/board'], ['POST', '/_hub/restart-hub'], ['POST', '/app/api/items']]) {
      const api = await fetch(base + p, { method, headers: { ...headers, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.deepEqual([api.status, api.headers.get('content-type'), api.headers.get('x-kickflip-down'), await api.text()], [403, 'application/json', 'access', '{}'], `${method} ${p}`);
    }
  }
  assert.equal(statusAsks(), 1);

  // An upgrade is gated the same way, before it reaches the site.
  assert.deepEqual(await upgrade(base, '/app/socket', phone), { status: 101, body: '/socket' });
  assert.deepEqual(await upgrade(base, '/app/socket', friend), { status: 403, body: '{}' });
  assert.deepEqual(await upgrade(base, '/app/socket', tagged), { status: 403, body: '{}' });
});

test("while tailscale can't name the owner, signed-in devices get a page saying so, and the Mac still gets in", async (t) => {
  const { base, home, statusAsks } = await startHub(t, { status: null });
  assert.equal((await fetch(`${base}/_hub/status.json`)).status, 200);
  const page = await fetch(`${base}/_hub/`, { headers: { ...phone, ...html } });
  assert.equal(page.status, 503);
  const text = await page.text();
  assert.match(text, /<p class="rf-line">Tailscale didn’t answer, so this kickflip can’t tell who you are\.<\/p>/);
  assert.match(text, /<p class="rf-sub">Open it on the Mac itself, or try again in a moment\.<\/p>/);
  const api = await fetch(`${base}/_hub/api/hub`, { headers: phone });
  assert.deepEqual([api.status, await api.json()], [503, { error: 'Tailscale didn’t answer, so the hub can’t tell who you are.' }]);
  assert.equal(statusAsks(), 1, 'a failed read is not retried at once');
  // A tagged node is refused whether or not tailscale answers.
  assert.equal((await fetch(`${base}/_hub/api/hub`, { headers: tagged })).status, 403);
  write(path.join(home, 'tailscale.status'), STATUS);
  const deadline = Date.now() + 15_000;
  let status;
  while ((status = (await fetch(`${base}/_hub/api/hub`, { headers: phone })).status) !== 200 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  assert.equal(status, 200, 'once tailscale answers, the owner gets in');
});

test('a board shared with a login lets that person read the shell and the board, view only, and Board settings sees them and who was refused', async (t) => {
  const { base, home } = await startHub(t, { status: STATUS, board: { title: 'Orch', share: ['friend@github'] } });
  const shared = { ...friend, 'tailscale-user-name': 'Friend Person' };
  const deadline = Date.now() + 15_000;
  while ((await fetch(`${base}/orch/x`).then((r) => r.text(), () => '')) !== 'orch GET /x' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

  // Their board's pages and reads reach it; the shell's files come from the hub.
  assert.equal(await (await fetch(`${base}/orch/api/board`, { headers: shared })).text(), 'orch GET /api/board');
  for (const p of ['/_hub/app/app.js', '/_hub/colors.css', '/sw.js', '/manifest.webmanifest']) assert.equal((await fetch(base + p, { headers: shared })).status, 200, p);
  const shell = await fetch(`${base}/orch/`, { headers: { ...shared, ...html, 'sec-fetch-dest': 'document' } });
  assert.equal(shell.status, 200);
  const page = await shell.text();
  const data = JSON.parse(/<script id="sidebarData" type="application\/json">(.*?)<\/script>/s.exec(page)[1]);
  assert.deepEqual([data.sites.map((s) => s.route), data.shared, data.start, data.usage, data.hub], [['orch'], { by: 'Love', full: [] }, 'orch', undefined, undefined]);
  assert.doesNotMatch(page, /href="\/app\/"/, 'the sidebar drawn in lists only their board');
  const sidebar = await (await fetch(`${base}/_hub/sidebar.json`, { headers: shared })).json();
  assert.deepEqual(sidebar.sites.map((s) => s.route), ['orch']);
  // The hub's own pages send them to their board.
  const hub = await fetch(`${base}/_hub/`, { headers: { ...shared, ...html }, redirect: 'manual' });
  assert.deepEqual([hub.status, hub.headers.get('location')], [302, '/']);

  // A write, or a read the owner keeps, is refused as view only; other boards and the hub's data as someone else's.
  for (const [method, p] of [['POST', '/orch/api/read'], ['POST', '/orch/_claude/events'], ['GET', '/orch/api/settings'], ['GET', '/orch/api/log?file=hub.log']]) {
    const r = await fetch(base + p, { method, headers: { ...shared, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.deepEqual([r.status, await r.json()], [403, { error: 'This board is shared with you to look at only.' }], `${method} ${p}`);
  }
  const viewOnly = await fetch(`${base}/orch/settings.html`, { headers: { ...shared, ...html } });
  assert.equal(viewOnly.status, 403);
  assert.match(await viewOnly.text(), /<p class="rf-line">You can look at this board, not change it\.<\/p>/);
  for (const [method, p] of [['GET', '/app/x'], ['GET', '/_hub/api/hub'], ['GET', '/_hub/share/orch'], ['POST', '/_hub/presence'], ['POST', '/_hub/push/subscribe']]) {
    const r = await fetch(base + p, { method, headers: { ...shared, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.deepEqual([r.status, await r.text()], [403, '{}'], `${method} ${p}`);
  }
  assert.deepEqual(await upgrade(base, '/orch/socket', shared), { status: 403, body: JSON.stringify({ error: 'This board is shared with you to look at only.' }) }, 'a shared view opens no upgrades');
  assert.deepEqual(await upgrade(base, '/app/socket', shared), { status: 403, body: '{}' });

  // Someone not shared is refused, and Board settings offers them; the shared person reads as seen.
  assert.equal((await fetch(`${base}/orch/`, { headers: { 'x-forwarded-for': '100.70.1.9', 'tailscale-user-login': 'jo@github', 'tailscale-user-name': 'Jo Park', ...html } })).status, 403);
  const sharing = await (await fetch(`${base}/_hub/share/orch`, { headers: phone })).json();
  assert.equal(sharing.link, 'https://studio.tail1234.ts.net/orch/');
  assert.deepEqual(sharing.people.map(({ login, name, now }) => ({ login, name, now })), [{ login: 'friend@github', name: 'Friend Person', now: false }]);
  assert.match(sharing.people[0].at, /^\d{4}-/);
  assert.deepEqual(sharing.refused.map(({ login, name }) => ({ login, name })), [{ login: 'jo@github', name: 'Jo Park' }]);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'kickflip', 'share-seen.json')));
  // A login the board no longer lists is someone else again.
  write(path.join(home, 'orch', 'board.json'), { title: 'Orch', share: [] });
  assert.equal((await fetch(`${base}/orch/api/board`, { headers: shared })).status, 403);
});

// → {status, body} for a GET of exactly `raw`, which fetch would normalise before sending
const rawGet = (base, raw, headers) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(base);
  http.get({ hostname, port, path: raw, headers }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test("a shared person's path is checked and forwarded as one parse, so no spelling reaches a read the owner keeps", async (t) => {
  const { base } = await startHub(t, { status: STATUS, board: { title: 'Orch', share: ['friend@github'] } });
  const deadline = Date.now() + 15_000;
  while ((await fetch(`${base}/orch/x`).then((r) => r.text(), () => '')) !== 'orch GET /x' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

  // The board strips its own /orch again and parses a leading // as a host, so these once reached its private reads.
  for (const raw of ['/orch/orch/api/log?file=hub.log', '/orch/orch/api/settings', '/orch//x/../api/log?file=hub.log', '/orch//api/log',
    '/orch/x/%2e%2e/api/log', '/orch/x/%2E%2E/api/settings', '/orch/%2e%2e/orch/api/log', '/orch/api%2flog', '/orch/%2forch/api/log', '/orch/%6frch/api/log',
    '/orch\\api\\log', '/orch/x\\..\\api/permissions', '/orch/\\x/../api/rules', '/orch/orch/orch/api/reviewer-people', '/orch/api/stream', '/orch/log.html']) {
    const r = await rawGet(base, raw, friend);
    assert.equal(r.status, 403, raw);
    assert.doesNotMatch(r.body, /^orch /, raw);
  }
  // A path that normalises to a board read reaches the board as that read.
  for (const [raw, seen] of [['/orch/x/../api/board', '/api/board'], ['/orch/x/%2e%2e/api/thread?key=a', '/api/thread?key=a'], ['/orch\\api\\board', '/api/board']]) {
    assert.deepEqual(await rawGet(base, raw, friend), { status: 200, body: `orch GET ${seen}` }, raw);
  }
  // The owner's requests go on as sent.
  assert.equal((await rawGet(base, '/orch//x/../y', phone)).body, 'orch GET //x/../y');
});

test("removing a share ends that person's open hub stream, and leaves the owner's", async (t) => {
  const { base, home } = await startHub(t, { status: STATUS, board: { title: 'Orch', share: ['friend@github'] } });
  const deadline = Date.now() + 15_000;
  while ((await fetch(`${base}/orch/x`).then((r) => r.text(), () => '')) !== 'orch GET /x' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const { hostname, port } = new URL(base);
  const open = (headers) => new Promise((resolve, reject) => {
    const req = http.get({ hostname, port, path: '/_hub/stream', headers }, (res) => {
      const s = { status: res.statusCode, ended: false };
      res.on('data', () => {});
      res.on('close', () => { s.ended = true; });
      resolve(s);
    });
    req.on('error', () => {});
    t.after(() => req.destroy());
    setTimeout(() => reject(new Error('no stream')), 5000);
  });
  const theirs = await open(friend);
  const owners = await open(phone);
  assert.deepEqual([theirs.status, owners.status], [200, 200]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(theirs.ended, false);

  // Board settings' Remove: the board writes board.json and answers the owner's POST.
  write(path.join(home, 'orch', 'board.json'), { title: 'Orch', share: [] });
  await fetch(`${base}/orch/api/share`, { method: 'POST', headers: { ...phone, 'content-type': 'application/json' }, body: JSON.stringify({ remove: 'friend@github' }) });
  const until = Date.now() + 5000;
  while (!theirs.ended && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(theirs.ended, true, 'their stream ended');
  assert.equal(owners.ended, false, "the owner's stream stays open");
  assert.equal((await fetch(`${base}/_hub/stream`, { headers: friend })).status, 403, 'and coming back is refused');
});

test("a Full person's events and uploads reach the board named as them, the owner's never do, and a level change ends their stream", async (t) => {
  const { base, home } = await startHub(t, { status: STATUS, board: { title: 'Orch', share: [{ login: 'friend@github', level: 'full' }] } });
  const deadline = Date.now() + 15_000;
  while ((await fetch(`${base}/orch/x`).then((r) => r.text(), () => '')) !== 'orch GET /x' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const post = (p, headers) => fetch(base + p, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });

  assert.equal(await (await post('/orch/_claude/events', friend)).text(), 'orch POST /_claude/events from friend@github');
  assert.equal(await (await post('/orch/api/upload', friend)).text(), 'orch POST /api/upload from friend@github');
  // Board settings and every other write stay the owner's.
  for (const p of ['/orch/api/share', '/orch/api/settings', '/orch/api/read']) {
    const r = await post(p, friend);
    assert.deepEqual([r.status, await r.json()], [403, { error: 'This board is shared with you to look at only.' }], p);
  }
  // The owner's request carries no shared login, whatever it sends.
  assert.equal(await (await post('/orch/_claude/events', { ...phone, 'x-kickflip-shared': 'friend@github' })).text(), 'orch POST /_claude/events from the owner');
  const data = await (await fetch(`${base}/_hub/sidebar.json`, { headers: friend })).json();
  assert.deepEqual(data.shared, { by: 'Love', full: ['orch'] });
  const sharing = await (await fetch(`${base}/_hub/share/orch`, { headers: phone })).json();
  assert.deepEqual(sharing.people.map(({ login, level }) => ({ login, level })), [{ login: 'friend@github', level: 'full' }]);

  // Back to View: their open stream ends, so the shell reopens it and follows the level, and their POST is refused.
  const { hostname, port } = new URL(base);
  const theirs = await new Promise((resolve, reject) => {
    const req = http.get({ hostname, port, path: '/_hub/stream', headers: friend }, (res) => {
      const s = { status: res.statusCode, ended: false };
      res.on('data', () => {});
      res.on('close', () => { s.ended = true; });
      resolve(s);
    });
    req.on('error', () => {});
    t.after(() => req.destroy());
    setTimeout(() => reject(new Error('no stream')), 5000);
  });
  assert.equal(theirs.status, 200);
  write(path.join(home, 'orch', 'board.json'), { title: 'Orch', share: ['friend@github'] });
  const until = Date.now() + 5000;
  while (!theirs.ended && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(theirs.ended, true, 'their stream ended');
  assert.equal((await post('/orch/_claude/events', friend)).status, 403);
  const back = await fetch(`${base}/_hub/stream`, { headers: friend });
  assert.equal(back.status, 200, 'and comes back, view only');
  await back.body.cancel();
});
