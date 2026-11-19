import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from './temp-dir.mjs';
import { SIGN_IN_COOKIE, agentCaller, blockedClients, deviceIdOf, devicesOf, isBlocked, makePin, noteSeen, pinOf, redeemPin, removeDevice, signInCookie, signInFile, signOutEverywhere, pinState, signedIn, unblock, voidPin, withoutOwnerCookie } from './owner-sign-in.mjs';

const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
const withCookie = (value, more = '') => req({ cookie: `theme=dark; ${SIGN_IN_COOKIE}=${value}${more}` });
const phone = { key: 'node:pixel-8', name: 'pixel-8', ip: '100.64.0.31' };
const stranger = { key: 'ip:192.168.1.9', name: '', ip: '192.168.1.9' };
// A clock a test moves by hand.
const clock = () => { let ms = Date.parse('2026-11-18T10:00:00Z'); const now = () => ms; now.add = (d) => { ms += d; }; return now; };

test('a PIN signs in one device once, and its device stays signed in', async () => {
  const home = tempDir('sign-in-');
  const { pin, until } = await makePin({ home });
  assert.match(pin, /^\d{8}$/);
  assert.ok(until > Date.now() + 59_000 && until <= Date.now() + 60_000, 'it lasts 60 seconds');
  assert.equal((fs.statSync(signInFile(home)).mode & 0o777), 0o600, 'only the owner reads the file');
  assert.doesNotMatch(fs.readFileSync(signInFile(home), 'utf8'), new RegExp(pin), 'the file keeps no PIN');
  const { device } = await redeemPin(` ${pin.slice(0, 4)} ${pin.slice(4)}\n`, phone, { home });
  assert.ok(device, 'whitespace anywhere in the PIN is dropped');
  assert.doesNotMatch(fs.readFileSync(signInFile(home), 'utf8'), new RegExp(device), 'the file keeps no device secret');
  assert.deepEqual(await redeemPin(pin, phone, { home }), { left: 2 }, 'a PIN signs in one device');
  assert.equal(signedIn(withCookie(device), home), true);
  assert.equal(signedIn(withCookie(device, '; other=1'), home), true);
  assert.equal(signedIn(withCookie(`${device}x`), home), false);
  assert.equal(signedIn(req(), home), false);
  assert.equal(signedIn(req({ cookie: `x${SIGN_IN_COOKIE}=${device}` }), home), false);
  const other = (await redeemPin((await makePin({ home })).pin, stranger, { home })).device;
  assert.equal(signedIn(withCookie(other), home), true, 'a second device signs in beside the first');
  assert.equal(signedIn(withCookie(device), home), true);
  assert.equal(await signOutEverywhere(home), 2);
  assert.equal(signedIn(withCookie(device), home), false);
  assert.equal(signedIn(withCookie(other), home), false);
});

test('a PIN lasts 60 seconds, and a voided one is gone at once', async () => {
  const home = tempDir('sign-in-');
  const now = clock();
  const late = (await makePin({ home, now })).pin;
  now.add(60_000);
  assert.deepEqual(await redeemPin(late, phone, { home, now }), { left: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(signInFile(home), 'utf8')).pins, [], 'an expired PIN is dropped as the file is next written');
  const closed = (await makePin({ home, now })).pin;
  assert.equal(await voidPin(closed, { home, now }), true);
  assert.equal(await voidPin(closed, { home, now }), false);
  assert.deepEqual(await redeemPin(closed, phone, { home, now }), { left: 1 });
  assert.equal(signedIn(withCookie('anything'), tempDir('sign-in-')), false, 'no file signs no one in');
  assert.equal(pinOf(' 1234\t5678 '), '12345678');
});

test("a client's third wrong PIN voids every live PIN and blocks it until unblocked; a right one forgets its misses", async () => {
  const home = tempDir('sign-in-');
  const now = clock();
  const live = (await makePin({ home, now })).pin;
  const wrong = live === '00000000' ? '00000001' : '00000000';
  assert.deepEqual(await redeemPin(wrong, phone, { home, now }), { left: 2 });
  assert.deepEqual(await redeemPin('not a pin', phone, { home, now }), { left: 1 });
  assert.deepEqual(await redeemPin(wrong, stranger, { home, now }), { left: 2 }, 'each client counts its own');
  assert.equal(isBlocked(phone, home), false);
  now.add(60_000 * 5);
  assert.deepEqual(await redeemPin(wrong, phone, { home, now }), { blocked: true });
  assert.equal(isBlocked(phone, home), true);
  assert.equal(isBlocked(stranger, home), false);
  const fresh = (await makePin({ home, now })).pin;
  assert.deepEqual(await redeemPin(fresh, phone, { home, now }), { blocked: true }, 'a blocked client signs in with no PIN, a right one too');
  assert.ok((await redeemPin(live, stranger, { home, now })).left, 'the PIN live at the block was voided');
  now.add(60_000);
  assert.deepEqual(await redeemPin(wrong, phone, { home, now }), { blocked: true });
  assert.deepEqual(blockedClients(home), [{ key: 'node:pixel-8', name: 'pixel-8', ip: '100.64.0.31', at: now() }], 'a block keeps the last attempt');
  assert.equal(await unblock('node:pixel-8', { home, now }), true);
  assert.equal(await unblock('node:pixel-8', { home, now }), false);
  assert.deepEqual(await redeemPin(wrong, phone, { home, now }), { left: 2 }, 'unblocked, it starts on three tries');
  assert.ok((await redeemPin((await makePin({ home, now })).pin, phone, { home, now })).device);
  assert.deepEqual(await redeemPin(wrong, phone, { home, now }), { left: 2 }, 'a sign-in forgets its misses');
  now.add(30 * 24 * 60 * 60_000);
  assert.deepEqual(await redeemPin(wrong, stranger, { home, now }), { blocked: true }, 'misses never fade: a third a month on blocks');
});

test('the devices list names each signed-in device, and one can be removed', async () => {
  const home = tempDir('sign-in-');
  const now = clock();
  const first = (await redeemPin((await makePin({ home, now })).pin, phone, { home, now })).device;
  now.add(60_000);
  const second = (await redeemPin((await makePin({ home, now })).pin, stranger, { device: { name: 'Safari on iPhone', ip: '192.168.1.9' }, home, now })).device;
  const listed = devicesOf(home);
  assert.deepEqual(listed.map((d) => [d.name, d.ip, d.at, d.seen]), [
    ['Safari on iPhone', '192.168.1.9', '2026-11-18T10:01:00.000Z', '2026-11-18T10:01:00.000Z'],
    ['pixel-8', '100.64.0.31', '2026-11-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z'],
  ]);
  assert.equal(deviceIdOf(withCookie(first), home), listed[1].id);
  assert.equal(deviceIdOf(req(), home), null);
  assert.doesNotMatch(listed[1].id, new RegExp(first), 'an id is no secret');

  now.add(60_000);
  assert.equal(await noteSeen(withCookie(first), { home, now }), false, 'seen is written at most every 5 minutes');
  now.add(5 * 60_000);
  assert.equal(await noteSeen(withCookie(first), { home, now }), true);
  assert.equal(devicesOf(home)[1].seen, '2026-11-18T10:07:00.000Z');

  assert.equal(await removeDevice(listed[1].id, { home, now }), true);
  assert.equal(await removeDevice(listed[1].id, { home, now }), false);
  assert.equal(signedIn(withCookie(first), home), false);
  assert.equal(signedIn(withCookie(second), home), true);
});

test('the cookie is HttpOnly and Lax for the whole host, Secure when the sign-in came over https', () => {
  assert.equal(signInCookie('v'), `${SIGN_IN_COOKIE}=v; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`);
  assert.equal(signInCookie('v', { secure: true }), `${SIGN_IN_COOKIE}=v; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`);
});

test('a relay passes on every cookie but the sign-in', () => {
  assert.equal(withoutOwnerCookie(`a=1; ${SIGN_IN_COOKIE}=s; b=2`), 'a=1; b=2');
  assert.equal(withoutOwnerCookie(`${SIGN_IN_COOKIE}=s`), undefined);
  assert.equal(withoutOwnerCookie(undefined), undefined);
});

test('an agent caller is a process on this host straight to loopback, never a browser or a forwarded request', () => {
  assert.equal(agentCaller(req()), true);
  assert.equal(agentCaller(req({}, '::ffff:127.0.0.1')), true);
  assert.equal(agentCaller(req({}, '::1')), true);
  assert.equal(agentCaller(req({}, '100.70.1.2')), false);
  assert.equal(agentCaller(req({ 'x-forwarded-for': '100.70.1.2' })), false, 'tailscale serve forwarded it');
  assert.equal(agentCaller(req({ origin: 'http://127.0.0.1:4500' })), false, 'a page sent it');
  assert.equal(agentCaller(req({ 'sec-fetch-site': 'same-origin' })), false, 'a browser sent it');
  assert.equal(agentCaller(req({ 'sec-fetch-mode': 'cors' })), true, "Node's fetch sends this");
});

test("a PIN reads live until a device signs in with it, then names that device; voided or expired unused, it's gone", async () => {
  const home = tempDir('sign-in-');
  const now = clock();
  const { pin } = await makePin({ home, now });
  assert.deepEqual(pinState(pin, { home, now }), { live: true });
  await redeemPin(pin, phone, { home, now });
  assert.deepEqual(pinState(pin, { home, now }), { used: 'pixel-8' });
  const voided = (await makePin({ home, now })).pin;
  await voidPin(voided, { home, now });
  assert.deepEqual(pinState(voided, { home, now }), { gone: true });
  const expired = (await makePin({ home, now })).pin;
  now.add(60_000);
  assert.deepEqual(pinState(expired, { home, now }), { gone: true });
});
