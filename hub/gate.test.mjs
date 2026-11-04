// docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md
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
const STATUS = { BackendState: 'Running', Self: { UserID: 7, TailscaleIPs: ['100.81.98.101'] }, User: { 7: { LoginName: 'lovek4d@github' } } };
const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github' };
const friend = { 'x-forwarded-for': '100.70.1.3', 'tailscale-user-login': 'friend@github' };
const tagged = { 'x-forwarded-for': '100.70.1.4' };
const html = { accept: 'text/html,application/xhtml+xml' };

// A hub on a temp HOME whose tailscale answers `status --json` from <home>/tailscale.status (failing while it's
// missing) and logs each call, beside a site whose server answers requests and upgrades with their path.
async function startHub(t, { status }) {
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
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: { app: { port: app.address().port, title: 'App' } } });
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
      assert.deepEqual([api.status, api.headers.get('content-type'), await api.text()], [403, 'application/json', '{}'], `${method} ${p}`);
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
