import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from './temp-dir.mjs';
import { SIGN_IN_COOKIE, agentCaller, makeSignInLink, redeemSignIn, signInCookie, signInFile, signOutEverywhere, signedIn, tokenOf, withoutOwnerCookie } from './owner-sign-in.mjs';

const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
const withCookie = (value, more = '') => req({ cookie: `theme=dark; ${SIGN_IN_COOKIE}=${value}${more}` });

test('a sign-in link signs in one device once, and its device stays signed in', async () => {
  const home = tempDir('sign-in-');
  const token = await makeSignInLink({ home });
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal((fs.statSync(signInFile(home)).mode & 0o777), 0o600, 'only the owner reads the file');
  assert.doesNotMatch(fs.readFileSync(signInFile(home), 'utf8'), new RegExp(token), 'the file keeps no link token');
  const device = await redeemSignIn(token, { home });
  assert.ok(device);
  assert.doesNotMatch(fs.readFileSync(signInFile(home), 'utf8'), new RegExp(device), 'the file keeps no device secret');
  assert.equal(await redeemSignIn(token, { home }), null, 'a link signs in one device');
  assert.equal(signedIn(withCookie(device), home), true);
  assert.equal(signedIn(withCookie(device, '; other=1'), home), true);
  assert.equal(signedIn(withCookie(`${device}x`), home), false);
  assert.equal(signedIn(req(), home), false);
  assert.equal(signedIn(req({ cookie: `x${SIGN_IN_COOKIE}=${device}` }), home), false);
  const other = await redeemSignIn(await makeSignInLink({ home }), { home });
  assert.equal(signedIn(withCookie(other), home), true, 'a second device signs in beside the first');
  assert.equal(signedIn(withCookie(device), home), true);
  assert.equal(await signOutEverywhere(home), 2);
  assert.equal(signedIn(withCookie(device), home), false);
  assert.equal(signedIn(withCookie(other), home), false);
});

test('a sign-in link lasts ten minutes', async () => {
  const home = tempDir('sign-in-');
  let ms = Date.parse('2026-11-18T10:00:00Z');
  const now = () => ms;
  const late = await makeSignInLink({ home, now });
  const fresh = await makeSignInLink({ home, now });
  ms += 10 * 60_000 + 1;
  assert.equal(await redeemSignIn(late, { home, now }), null);
  const kept = JSON.parse(fs.readFileSync(signInFile(home), 'utf8'));
  assert.deepEqual(kept.links, [], 'an expired link is dropped as the file is next written');
  assert.equal(await redeemSignIn(fresh, { home, now }), null);
  assert.equal(await redeemSignIn('', { home, now }), null);
  assert.equal(signedIn(withCookie('anything'), tempDir('sign-in-')), false, 'no file signs no one in');
});

test('a sign-in link pasted whole, or its token alone, names the token', () => {
  assert.equal(tokenOf('https://mac.tail.ts.net/_hub/sign-in?t=abc_-1'), 'abc_-1');
  assert.equal(tokenOf('  http://127.0.0.1:4500/_hub/sign-in?t=abc  '), 'abc');
  assert.equal(tokenOf('abc_-1'), 'abc_-1');
  assert.equal(tokenOf('not a token'), '');
  assert.equal(tokenOf(undefined), '');
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
