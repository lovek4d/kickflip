// docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md
// docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md
import { home, web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { SIGN_IN_COOKIE, devicesOf, makePin, redeemPin, signedIn } from '../shared/owner-sign-in.mjs';
import { clientIdentity } from '../board/on-host.mjs';

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
  // No tailscale answers, so each client is its address: X-Forwarded-For's, as tailscale serve sends it, else loopback.
  const hub = await inProcessHub(t, { gate: async () => 'owner', signedIn: (req) => signedIn(req, home), identify: clientIdentity(async () => null) });
  await hub.settled();
  return hub.base;
}

const device = async () => `${SIGN_IN_COOKIE}=${(await redeemPin((await makePin({ home })).pin, { key: 'ip:test' }, { home })).device}`;
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
    assert.match(text, /<form class="rf-form" method="post" action="\/_hub\/sign-in"><input type="hidden" name="next" value="([^"]*)"><input name="pin" value="" placeholder="8-digit PIN"/);
    assert.match(text, /Run <code>kickflip link<\/code> on its Mac, or tap Sign in a device/);
    assert.equal(/name="next" value="([^"]*)"/.exec(text)[1], p, 'the sign-in lands back where it was asked');
  }
  for (const [method, p] of [['GET', '/_hub/api/hub'], ['GET', '/_hub/sidebar.json'], ['GET', '/app/x'], ['POST', '/_hub/restart-hub'], ['POST', '/_hub/prompts/p1/answer'], ['POST', '/_hub/settings/notifications']]) {
    const answer = await fetch(base + p, { method, headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.deepEqual([answer.status, answer.headers.get('x-kickflip-down'), await answer.json()], [401, 'signed-out', { error: 'Sign in first: run kickflip link on the hub’s Mac and type the PIN it prints.' }], `${method} ${p}`);
  }
  for (const p of ['/_hub/kickflip.png', '/_hub/icon-180.png', '/manifest.webmanifest', '/sw.js', '/_hub/colors.css', '/_hub/hub.css', '/_hub/app/ui.js', '/favicon.ico']) {
    assert.ok([200, 301].includes((await fetch(base + p, { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' })).status), p);
  }
  assert.equal((await fetch(`${base}/sw.js`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'only reads are open');
  assert.deepEqual(await upgrade(base, '/app/socket'), { status: 401, body: JSON.stringify({ error: 'Sign in first: run kickflip link on the hub’s Mac and type the PIN it prints.' }) });
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

const form = (base, pin, next = '/orch/', headers = {}) => fetch(`${base}/_hub/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin', ...html, ...headers }, body: new URLSearchParams({ pin, next }) });

test('the sign-in page takes a live PIN once and sets the device cookie', async (t) => {
  const base = await startHub(t);
  const asked = await fetch(`${base}/_hub/sign-in?t=an-old-link`, { headers: page });
  assert.deepEqual([asked.status, asked.headers.get('set-cookie')], [401, null]);
  assert.match(await asked.text(), /<input name="pin" value=""/, 'an old link opens the PIN page');

  const { pin } = await makePin({ home });
  assert.equal((await form(base, pin, '/', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403, 'another site can\'t post a sign-in');
  const signed = await form(base, `${pin.slice(0, 4)} ${pin.slice(4)}`, '/orch/', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1' });
  assert.equal(signed.status, 303, 'a space a phone added to the PIN is dropped');
  assert.equal(signed.headers.get('location'), '/orch/');
  const cookie = signed.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^${SIGN_IN_COOKIE}=[\\w-]+; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax$`));
  const value = cookie.split(';')[0];
  assert.deepEqual(devicesOf(home).map((d) => [d.name, d.ip]).at(0), ['Safari on iPhone', '127.0.0.1'], 'a device with no node name reads its browser and OS');

  const again = await form(base, pin, '/', { 'x-forwarded-for': '100.64.0.2' });
  assert.equal(again.status, 403);
  assert.match(await again.text(), /<p class="rf-err">Wrong PIN, 2 tries left<\/p>/, 'a PIN signs in one device');

  const shell = await fetch(`${base}/`, { headers: { ...page, cookie: value } });
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('x-app-shell'), '1');
  assert.equal((await fetch(`${base}/_hub/api/hub`, { headers: { cookie: value } })).status, 200);
  assert.equal((await fetch(`${base}/_hub/sign-in`, { headers: { ...page, cookie: value }, redirect: 'manual' })).headers.get('location'), '/', 'a signed-in device opening the page goes home');
  assert.deepEqual(await upgrade(base, '/app/socket', { cookie: value }), { status: 101, body: '/socket' });

  // A landing off this host lands home; over tailscale serve's https the cookie is Secure.
  const offsite = await form(base, (await makePin({ home })).pin, '//evil.example/');
  assert.deepEqual([offsite.status, offsite.headers.get('location')], [303, '/']);
  const secure = await form(base, (await makePin({ home })).pin, '/', { 'x-forwarded-proto': 'https' });
  assert.match(secure.headers.get('set-cookie'), /; Secure$/);
});

test("a client's third wrong PIN voids the live PIN and blocks it on every page", async (t) => {
  const base = await startHub(t);
  const phone = { 'x-forwarded-for': '100.64.0.31' };
  const { pin } = await makePin({ home });
  const wrong = pin === '00000000' ? '00000001' : '00000000';
  const first = await form(base, wrong, '/', phone);
  assert.equal(first.status, 403);
  assert.match(await first.text(), /<input name="pin" class="err"[^>]*>[\s\S]*<p class="rf-err">Wrong PIN, 2 tries left<\/p>/);
  assert.match(await (await form(base, wrong, '/', phone)).text(), /Wrong PIN, 1 try left/);
  const third = await form(base, wrong, '/', phone);
  assert.equal(third.status, 403);
  const blocked = await third.text();
  assert.match(blocked, /<p class="rf-line">This device has been blocked, use <code>kickflip unblock<\/code> on the host machine<\/p>/);
  assert.doesNotMatch(blocked, /<form/, 'a blocked page takes no PIN');
  for (const p of ['/', '/_hub/sign-in', '/orch/']) assert.match(await (await fetch(base + p, { headers: { ...page, ...phone } })).text(), /This device has been blocked/, p);
  const api = await fetch(`${base}/_hub/api/hub`, { headers: phone });
  assert.deepEqual([api.status, await api.json()], [403, { error: 'This device has been blocked, use kickflip unblock on the host machine' }]);
  assert.match(await (await form(base, (await makePin({ home })).pin, '/', phone)).text(), /This device has been blocked/, 'a blocked client signs in with no PIN');
  assert.match(await (await fetch(`${base}/`, { headers: page })).text(), /Sign in to open this kickflip\./, 'another client still gets the PIN page');
  assert.match(await (await form(base, pin)).text(), /Wrong PIN, 2 tries left/, 'the PIN live at the block was voided');
});

test('a signed-in page makes and voids a PIN, and lists and removes devices', async (t) => {
  const base = await startHub(t);
  const mine = await device();
  await device();
  const made = await (await fetch(`${base}/_hub/pins`, { method: 'POST', headers: { cookie: mine } })).json();
  assert.match(made.pin, /^\d{8}$/);
  assert.ok(made.until > Date.now() + 55_000);
  assert.match(made.address, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'with the tailnet off, this host\'s address');
  assert.deepEqual(await (await fetch(`${base}/_hub/pins/${made.pin}`, { method: 'DELETE', headers: { cookie: mine } })).json(), { voided: true });
  assert.match(await (await form(base, made.pin)).text(), /Wrong PIN/, 'a closed dialog\'s PIN is void');

  const { devices } = await (await fetch(`${base}/_hub/devices`, { headers: { cookie: mine } })).json();
  assert.equal(devices.filter((d) => d.me).length, 1);
  const them = devices.find((d) => !d.me);
  const removed = await fetch(`${base}/_hub/devices/${them.id}`, { method: 'DELETE', headers: { cookie: mine } });
  assert.deepEqual(await removed.json(), { removed: true });
  assert.equal(devicesOf(home).some((d) => d.id === them.id), false);
  assert.equal((await fetch(`${base}/_hub/devices/${them.id}`, { method: 'DELETE', headers: { cookie: mine } })).status, 404);
  for (const [method, p] of [['POST', '/_hub/pins'], ['GET', '/_hub/devices'], ['DELETE', `/_hub/devices/${devices[0].id}`]]) {
    assert.equal((await fetch(base + p, { method })).status, 401, `${method} ${p} needs the sign-in`);
  }
});

test("a site that isn't a board never gets the sign-in cookie; a board's server does, to check it", async (t) => {
  const base = await startHub(t);
  const cookie = await device();
  assert.equal(await (await fetch(`${base}/app/x`, { headers: { cookie: `a=1; ${cookie}` } })).text(), 'app /x cookie=a=1');
  assert.equal(await (await fetch(`${base}/orch/api/board`, { headers: { cookie: `a=1; ${cookie}` } })).text(), `orch /api/board cookie=a=1; ${cookie}`);
});
