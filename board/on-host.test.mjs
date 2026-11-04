import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHost, ownerGate } from './on-host.mjs';

// The headers tailscale serve sent live (docs/adr/2026-11-04-0236-the-hub-tells-the-hosts-browser-by-its-forwarded-address-then-its-tailnet-node.md):
// X-Forwarded-For is the client's tailnet address, Tailscale-User-Login and Tailscale-User-Name its user; no node header.
const tailnet = ['100.81.98.101', 'fd7a:115c:a1e0::8601:62c1'];
const node = { login: 'lovek4d@github', addresses: tailnet };
const served = (address, login = 'lovek4d@github') => ({ 'x-forwarded-for': address, 'tailscale-user-login': login, 'tailscale-user-name': 'Love' });

test("a request is from the host when tailscale serve names one of the host's own addresses, or when it came straight to loopback", async () => {
  let asked = 0;
  const host = { addresses: () => ['127.0.0.1', '::1', ...tailnet], node: async () => { asked++; return node; } };
  const at = (headers, remote = '127.0.0.1') => fromHost({ headers, socket: { remoteAddress: remote } }, host);
  assert.equal(await at(served('100.81.98.101')), true);
  assert.equal(await at(served('fd7a:115c:a1e0::8601:62c1')), true);
  assert.equal(await at({ 'x-forwarded-for': '100.81.98.101' }), true);
  assert.equal(await at({ 'x-forwarded-for': '100.81.98.101, 100.70.1.2' }), false);
  assert.equal(await at({}), true);
  assert.equal(await at({}, '::ffff:127.0.0.1'), true);
  assert.equal(await at({}, '192.168.1.40'), false);
  assert.equal(asked, 0);
  // The owner's phone signs in as the same user, from its own node's address.
  assert.equal(await at(served('100.70.1.2')), false);
  assert.equal(asked, 1);
});

test("with the host's tailnet address on no interface, the host is the request whose user and forwarded address are the host node's", async () => {
  const at = (headers, found = node) => fromHost({ headers, socket: { remoteAddress: '127.0.0.1' } }, { addresses: () => ['127.0.0.1', '::1'], node: async () => found });
  assert.equal(await at(served('100.81.98.101')), true);
  assert.equal(await at(served('::ffff:100.81.98.101')), true);
  assert.equal(await at(served('fd7a:115c:a1e0::8601:62c1')), true);
  assert.equal(await at(served('100.70.1.2')), false);
  assert.equal(await at(served('100.81.98.101', 'someone@else')), false);
  assert.equal(await at({ 'x-forwarded-for': '100.81.98.101' }), false);
  assert.equal(await at({ 'x-forwarded-for': '100.81.98.101', 'tailscale-node-name': 'loves-macbook-pro' }), false);
  assert.equal(await at(served('100.81.98.101'), null), false);
  assert.equal(await at({ 'tailscale-user-login': 'lovek4d@github' }), true);
});

test("the gate lets in the host, a direct loopback caller and any device signed in as the host node's user, reading that user once", async () => {
  let asked = 0;
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1', ...tailnet], node: async () => { asked++; return node; } });
  const at = (headers, remote = '127.0.0.1') => gate({ headers, socket: { remoteAddress: remote } });
  // The host and a direct loopback caller are the owner without asking tailscale.
  assert.equal(await at(served('100.81.98.101')), 'owner');
  assert.equal(await at({}), 'owner');
  assert.equal(asked, 0);
  // The owner's phone, signed in as the host's user from its own node; the user is kept once read.
  assert.deepEqual(await Promise.all([at(served('100.70.1.2')), at(served('100.70.1.2'))]), ['owner', 'owner']);
  assert.equal(await at(served('100.70.1.2')), 'owner');
  assert.equal(asked, 1);
  // A shared-in node carries the sharer's login; a tagged node or Funnel has none.
  assert.equal(await at(served('100.70.1.3', 'friend@github')), 'other');
  assert.equal(await at({ 'x-forwarded-for': '100.70.1.4' }), 'other');
  assert.equal(asked, 1);
});

test("until tailscale names the host's user, a signed-in request is unread, and tailscale is asked again only after a pause", async () => {
  let clock = 0;
  let answer = null;
  let asked = 0;
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => { asked++; return answer; } }, { now: () => clock });
  const at = (headers) => gate({ headers, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(await at(served('100.70.1.2')), 'unread');
  assert.equal(await at(served('100.70.1.3', 'friend@github')), 'unread');
  assert.equal(asked, 1);
  // A request with no login is never the owner, so it needs no answer.
  assert.equal(await at({ 'x-forwarded-for': '100.70.1.4' }), 'other');
  // The host's own loopback caller still gets in.
  assert.equal(await at({}), 'owner');
  answer = node;
  clock += 4_999;
  assert.equal(await at(served('100.70.1.2')), 'unread');
  clock += 1;
  assert.equal(await at(served('100.70.1.2')), 'owner');
  assert.equal(asked, 2);
  answer = null;
  clock += 60_000;
  assert.equal(await at(served('100.70.1.2')), 'owner');
  assert.equal(asked, 2);
});
