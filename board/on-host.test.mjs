import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHost } from './on-host.mjs';

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
