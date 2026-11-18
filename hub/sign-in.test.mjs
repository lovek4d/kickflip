// docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md
import { home, web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { SIGN_IN_COOKIE, makeSignInLink, redeemSignIn, signedIn } from '../shared/owner-sign-in.mjs';

const html = { accept: 'text/html,application/xhtml+xml' };
const page = { ...html, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' };
// The board server the hub runs for /orch only stays up: the test's own server on the board's port answers for it.
write(path.join(home, 'stand-in', 'board', 'server.mjs'), 'setInterval(() => {}, 2 ** 30);\n');

// A server that answers each request with its site's name, path and the Cookie header it got. → its port
async function standIn(t, name) {
  const server = http.createServer((req, res) => res.end(`${name} ${req.url} cookie=${req.headers.cookie || ''}`));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n' + req.url));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// A hub whose gate lets everyone in, so only the sign-in decides, with a plain site /app and a board site /orch.
async function startHub(t) {
  fs.rmSync(web, { recursive: true, force: true });
  const dir = path.join(home, 'orch');
  write(path.join(dir, 'board.json'), { title: 'Orch', items: 'waves' });
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {
    app: { port: await standIn(t, 'app'), title: 'App' },
    orch: { port: await standIn(t, 'orch'), title: 'Orch', dir, cmd: [process.execPath, path.join(home, 'stand-in', 'board', 'server.mjs')] },
  } });
  const hub = await inProcessHub(t, { gate: async () => 'owner', signedIn: (req) => signedIn(req, home) });
  await hub.settled();
  return hub.base;
}

const device = async () => `${SIGN_IN_COOKIE}=${await redeemSignIn(await makeSignInLink({ home }), { home })}`;
const upgrade = (base, pathname, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request(base + pathname, { headers: { connection: 'Upgrade', upgrade: 'test', ...headers } });
  request.on('error', reject);
  request.on('response', (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
  request.on('upgrade', (res, socket, head) => { socket.destroy(); resolve({ status: res.statusCode, body: head.toString() }); });
  request.end();
});

test('a device without the sign-in gets the sign-in page on every page and API path, and the app\'s code and icons open', async (t) => {
  const base = await startHub(t);
  for (const p of ['/', '/_hub/', '/_hub/settings', '/app/', '/orch/']) {
    const answer = await fetch(base + p, { headers: page });
    assert.equal(answer.status, 401, p);
    const text = await answer.text();
    assert.match(text, /<p class="rf-line">Sign in to open this kickflip\.<\/p>/);
    assert.match(text, /<form class="rf-form" method="post" action="\/_hub\/sign-in"><input type="hidden" name="next" value="([^"]*)"><input name="link" value=""/);
    assert.equal(/name="next" value="([^"]*)"/.exec(text)[1], p, 'the sign-in lands back where it was asked');
  }
  for (const [method, p] of [['GET', '/_hub/api/hub'], ['GET', '/_hub/sidebar.json'], ['GET', '/app/x'], ['POST', '/_hub/restart-hub'], ['POST', '/_hub/prompts/p1/answer'], ['POST', '/_hub/settings/notifications']]) {
    const answer = await fetch(base + p, { method, headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.deepEqual([answer.status, answer.headers.get('x-kickflip-down'), await answer.json()], [401, 'signed-out', { error: 'Sign in first: run kickflip sign-in on the hub’s Mac and open the link it prints.' }], `${method} ${p}`);
  }
  for (const p of ['/_hub/kickflip.png', '/_hub/icon-180.png', '/manifest.webmanifest', '/sw.js', '/_hub/colors.css', '/_hub/hub.css', '/_hub/app/ui.js', '/favicon.ico']) {
    assert.ok([200, 301].includes((await fetch(base + p, { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' })).status), p);
  }
  assert.equal((await fetch(`${base}/sw.js`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'only reads are open');
  assert.deepEqual(await upgrade(base, '/app/socket'), { status: 401, body: JSON.stringify({ error: 'Sign in first: run kickflip sign-in on the hub’s Mac and open the link it prints.' }) });
});

test('a process on this host gets the agent paths with no cookie, and no owner path', async (t) => {
  const base = await startHub(t);
  assert.equal((await fetch(`${base}/_hub/status.json`)).status, 200);
  assert.equal((await fetch(`${base}/_hub/needs.json`)).status, 200);
  assert.equal((await fetch(`${base}/_hub/prompts/none/wait?ms=1`)).status, 404, 'past the sign-in, to a prompt that is gone');
  assert.equal((await fetch(`${base}/_hub/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400, 'past the sign-in, to the hook input check');
  // The same paths from a browser, or through tailscale serve, need the sign-in.
  assert.equal((await fetch(`${base}/_hub/status.json`, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 401);
  assert.equal((await fetch(`${base}/_hub/status.json`, { headers: { 'x-forwarded-for': '100.70.1.2' } })).status, 401);
  for (const [method, p] of [['POST', '/_hub/prompts/p1/answer'], ['GET', '/_hub/api/hub'], ['POST', '/_hub/restart-hub'], ['GET', '/app/x']]) {
    assert.equal((await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).status, 401, `${method} ${p}`);
  }
  // A board's own paths reach its server, which checks them itself (board/sign-in.test.mjs).
  assert.equal(await (await fetch(`${base}/orch/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).text(), 'orch /_claude/events cookie=');
  assert.equal(await (await fetch(`${base}/orch/app.js`, { headers: { 'sec-fetch-site': 'cross-site' } })).text(), 'orch /app.js cookie=');
});

test('a sign-in link opens a page asking to sign in, and its Sign in sets the device cookie once', async (t) => {
  const base = await startHub(t);
  const token = await makeSignInLink({ home });
  const link = `${base}/_hub/sign-in?t=${token}`;
  const asked = await fetch(link, { headers: page });
  assert.equal(asked.status, 200);
  const text = await asked.text();
  assert.match(text, /<p class="rf-line">Sign in on this device\?<\/p>/);
  assert.match(text, new RegExp(`<input name="link" value="${token}"`));
  assert.equal(asked.headers.get('set-cookie'), null, 'opening the link uses nothing up, so a link preview can\'t');

  const form = (link, next = '/orch/', headers = {}) => fetch(`${base}/_hub/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin', ...html, ...headers }, body: new URLSearchParams({ link, next }) });
  assert.equal((await form(link, '/', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403, 'another site can\'t post a sign-in');
  const signed = await form(link);
  assert.equal(signed.status, 303);
  assert.equal(signed.headers.get('location'), '/orch/');
  const cookie = signed.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^${SIGN_IN_COOKIE}=[\\w-]+; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax$`));
  const value = cookie.split(';')[0];

  const again = await form(link);
  assert.equal(again.status, 403);
  assert.match(await again.text(), /That sign-in link has expired or was already used\./);

  const shell = await fetch(`${base}/`, { headers: { ...page, cookie: value } });
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('x-app-shell'), '1');
  assert.equal((await fetch(`${base}/_hub/api/hub`, { headers: { cookie: value } })).status, 200);
  assert.equal((await fetch(`${base}/_hub/sign-in`, { headers: { ...page, cookie: value }, redirect: 'manual' })).headers.get('location'), '/', 'a signed-in device opening the bare page goes home');
  assert.deepEqual(await upgrade(base, '/app/socket', { cookie: value }), { status: 101, body: '/socket' });

  // A pasted token alone signs in too, and a landing off this host lands home.
  const pasted = await form(await makeSignInLink({ home }), '//evil.example/');
  assert.deepEqual([pasted.status, pasted.headers.get('location')], [303, '/']);
  assert.match(pasted.headers.get('set-cookie'), /; Path=\/;/);
  const secure = await form(await makeSignInLink({ home }), '/', { 'x-forwarded-proto': 'https' });
  assert.match(secure.headers.get('set-cookie'), /; Secure$/, 'over tailscale serve\'s https, the cookie is Secure');
});

test("a site that isn't a board never gets the sign-in cookie; a board's server does, to check it", async (t) => {
  const base = await startHub(t);
  const cookie = await device();
  assert.equal(await (await fetch(`${base}/app/x`, { headers: { cookie: `a=1; ${cookie}` } })).text(), 'app /x cookie=a=1');
  assert.equal(await (await fetch(`${base}/orch/api/board`, { headers: { cookie: `a=1; ${cookie}` } })).text(), `orch /api/board cookie=a=1; ${cookie}`);
});
