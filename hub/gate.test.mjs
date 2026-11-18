// docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md
// docs/adr/2026-11-18-0700-the-hub-has-no-sharing-only-the-owners-tailnet-identity-gets-in.md
import { home, web, bin, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ownerGate } from '../board/on-host.mjs';

const STATUS = { BackendState: 'Running', Self: { UserID: 7, TailscaleIPs: ['100.81.98.101'], DNSName: 'studio.tail1234.ts.net.' }, User: { 7: { LoginName: 'lovek4d@github', DisplayName: 'Love' } } };
const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github' };
const friend = { 'x-forwarded-for': '100.70.1.3', 'tailscale-user-login': 'friend@github' };
const tagged = { 'x-forwarded-for': '100.70.1.4' };
const html = { accept: 'text/html,application/xhtml+xml' };

// The tailscale the hub runs answers `status --json` from <home>/tailscale.status (failing while it's missing) and
// logs each call.
write(path.join(bin, 'tailscale'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(path.join(process.env.HOME, 'tailscale.calls'), args + '\\n');
const file = path.join(process.env.HOME, 'tailscale.status');
if (args !== 'status --json' || !fs.existsSync(file)) process.exit(1);
console.log(fs.readFileSync(file, 'utf8'));
`);
fs.chmodSync(path.join(bin, 'tailscale'), 0o755);
// The board server the hub runs for /orch only stays up: the test's own server on the board's port answers for it.
write(path.join(home, 'stand-in', 'board', 'server.mjs'), 'setInterval(() => {}, 2 ** 30);\n');

// A server that answers requests and upgrades with their path; a board's (named) also with the method. → its port; it
// closes after the test
async function standIn(t, board = null) {
  const server = http.createServer((req, res) => res.end(board ? `${board} ${req.method} ${req.url}` : `app ${req.url}`));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n' + req.url));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// A hub on a fresh kickflip folder, beside a site /app, whose owner gate reads tailscale on a clock the test moves
// (clock.ms). board: a board.json for a board site /orch, whose server the hub runs. Resolves once the hub's startup
// pass has started /orch.
async function startHub(t, { status, board }) {
  fs.rmSync(web, { recursive: true, force: true });
  for (const file of ['tailscale.calls', 'tailscale.status']) fs.rmSync(path.join(home, file), { force: true });
  if (status) write(path.join(home, 'tailscale.status'), status);
  const sites = { app: { port: await standIn(t), title: 'App' } };
  if (board) {
    const dir = path.join(home, 'orch');
    write(path.join(dir, 'board.json'), board);
    sites.orch = { port: await standIn(t, 'orch'), title: 'Orch', dir, cmd: [process.execPath, path.join(home, 'stand-in', 'board', 'server.mjs')] };
  }
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites });
  // These tests are the tailnet's devices reaching the hub through tailscale serve, so the tailnet is on.
  write(path.join(web, 'settings.json'), { tailnet: true });
  const clock = { ms: 0 };
  const hub = await inProcessHub(t, { gate: ownerGate(undefined, { now: () => clock.ms }) });
  await hub.settled();
  const statusAsks = () => { try { return fs.readFileSync(path.join(home, 'tailscale.calls'), 'utf8').split('\n').filter((l) => l === 'status --json').length; } catch { return 0; } };
  return { base: hub.base, hub, clock, statusAsks };
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
      assert.match(text, /<p class="rf-sub">Only its owner’s Tailscale account opens it\.<\/p>/);
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
  const { base, clock, statusAsks } = await startHub(t, { status: null });
  assert.equal((await fetch(`${base}/_hub/status.json`)).status, 200);
  const page = await fetch(`${base}/_hub/`, { headers: { ...phone, ...html } });
  assert.equal(page.status, 503);
  const text = await page.text();
  assert.match(text, /<p class="rf-line">Tailscale didn’t answer, so this kickflip can’t tell who you are\.<\/p>/);
  assert.match(text, /<p class="rf-sub">Open it on the host itself, or try again in a moment\.<\/p>/);
  const api = await fetch(`${base}/_hub/api/hub`, { headers: phone });
  assert.deepEqual([api.status, await api.json()], [503, { error: 'Tailscale didn’t answer, so the hub can’t tell who you are.' }]);
  assert.equal(statusAsks(), 1, 'a failed read is not retried at once');
  // A tagged node is refused whether or not tailscale answers.
  assert.equal((await fetch(`${base}/_hub/api/hub`, { headers: tagged })).status, 403);
  write(path.join(home, 'tailscale.status'), STATUS);
  clock.ms += 4999;
  assert.equal((await fetch(`${base}/_hub/api/hub`, { headers: phone })).status, 503, 'nor before its retry is due');
  assert.equal(statusAsks(), 1);
  clock.ms += 1;
  assert.equal((await fetch(`${base}/_hub/api/hub`, { headers: phone })).status, 200, 'once tailscale answers, the owner gets in');
  assert.equal(statusAsks(), 2);
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

test('a login a board.json still lists under its old share is refused like anyone else, on every path and upgrade', async (t) => {
  const { base, hub: running } = await startHub(t, { status: STATUS, board: { title: 'Orch', share: ['friend@github', { login: 'pat@github', level: 'full' }] } });
  for (const who of [friend, { 'x-forwarded-for': '100.70.1.5', 'tailscale-user-login': 'pat@github' }]) {
    const headers = { ...who, 'tailscale-user-name': 'Friend Person' };
    for (const [method, p] of [['GET', '/orch/'], ['GET', '/orch/api/board'], ['GET', '/_hub/sidebar.json'], ['GET', '/_hub/app/app.js'], ['GET', '/_hub/'],
      ['POST', '/orch/_claude/events'], ['POST', '/orch/api/upload']]) {
      const r = await fetch(base + p, { method, headers: { ...headers, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.deepEqual([r.status, await r.text()], [403, '{}'], `${who['tailscale-user-login']} ${method} ${p}`);
    }
    const page = await fetch(`${base}/orch/`, { headers: { ...headers, ...html, 'sec-fetch-dest': 'document' } });
    assert.equal(page.status, 403);
    assert.match(await page.text(), /<p class="rf-line">This kickflip belongs to someone else\.<\/p>/);
    assert.deepEqual(await upgrade(base, '/orch/socket', headers), { status: 403, body: '{}' });
  }
  // The owner's requests go on as sent, and the hub keeps no sharing page or record.
  assert.equal(await (await fetch(`${base}/orch/api/board`, { headers: phone })).text(), 'orch GET /api/board');
  assert.equal((await rawGet(base, '/orch//x/../y', phone)).body, 'orch GET //x/../y');
  assert.equal((await fetch(`${base}/_hub/share/orch`, { headers: phone })).status, 404);
  await running.close();
  assert.equal(fs.existsSync(path.join(web, 'share-seen.json')), false);
});
