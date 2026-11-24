import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIdentity, fromHost, ownerGate } from './on-host.mjs';

// The headers tailscale serve sent live (docs/adr/2026-11-04-0236-the-hub-tells-the-hosts-browser-by-its-forwarded-address-then-its-tailnet-node.md):
// X-Forwarded-For is the client's tailnet address, Tailscale-User-Login and Tailscale-User-Name its user; no node header.
const tailnet = ['100.81.98.101', 'fd7a:115c:a1e0::8601:62c1'];
const node = { login: 'lovek4d@github', addresses: tailnet };
// The tailnet's switch (shared/tailnet.mjs tailnetOn), which the host reads on each request.
const on = () => true;
const served = (address, login = 'lovek4d@github') => ({ 'x-forwarded-for': address, 'tailscale-user-login': login, 'tailscale-user-name': 'Love' });

test("a request is from the host when tailscale serve names one of the host's own addresses, or when it came straight to loopback", async () => {
  let asked = 0;
  const host = { addresses: () => ['127.0.0.1', '::1', ...tailnet], node: async () => { asked++; return node; }, tailnet: on };
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
  const at = (headers, found = node) => fromHost({ headers, socket: { remoteAddress: '127.0.0.1' } }, { addresses: () => ['127.0.0.1', '::1'], node: async () => found, tailnet: on });
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
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1', ...tailnet], node: async () => { asked++; return node; }, tailnet: on });
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
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => { asked++; return answer; }, tailnet: on }, { now: () => clock });
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

test("with the tailnet off, only a loopback client is the host and the owner, and tailscale's login is never read", async () => {
  let asked = 0;
  let tailnetOn = false;
  const host = { addresses: () => ['127.0.0.1', '::1', '192.168.1.40', ...tailnet], node: async () => { asked++; return node; }, tailnet: () => tailnetOn };
  const gate = ownerGate(host);
  const request = (headers, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } });
  const both = async (headers, remote) => [await fromHost(request(headers, remote), host), await gate(request(headers, remote))];
  assert.deepEqual(await both({}), [true, 'owner']);
  assert.deepEqual(await both({}, '::1'), [true, 'owner']);
  assert.deepEqual(await both({}, '::ffff:127.0.0.1'), [true, 'owner']);
  assert.deepEqual(await both({ 'tailscale-user-login': 'lovek4d@github' }), [true, 'owner']);
  // A tailscale serve mapping nobody removed still sends the tailnet's devices from loopback, each named by its forwarded
  // address: none of them is the host or the owner, not even the host node's own address or user.
  assert.deepEqual(await both(served('100.70.1.2')), [false, 'other']);
  assert.deepEqual(await both(served('100.81.98.101')), [false, 'other']);
  assert.deepEqual(await both({ 'x-forwarded-for': '100.70.1.4' }), [false, 'other']);
  assert.deepEqual(await both({}, '192.168.1.40'), [false, 'other']);
  assert.equal(asked, 0);
  // Turned on, the same gate reads tailscale's login again.
  tailnetOn = true;
  assert.deepEqual(await both(served('100.70.1.2')), [false, 'owner']);
  assert.equal(asked, 2);
});

// docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md
test('a sign-in client is its tailnet node by name through tailscale serve, else its address', async () => {
  const status = { Self: { TailscaleIPs: ['100.81.98.101'], DNSName: 'Studio.tail1234.ts.net.' }, Peer: { a: { TailscaleIPs: ['100.64.0.31', 'fd7a::1'], DNSName: 'pixel-8.tail1234.ts.net.' } } };
  const identify = clientIdentity(async () => status);
  const forwarded = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } });
  assert.deepEqual(await identify(forwarded('100.64.0.31')), { key: 'node:pixel-8', name: 'pixel-8', ip: '100.64.0.31' });
  assert.deepEqual(await identify(forwarded('100.81.98.101')), { key: 'node:studio', name: 'studio', ip: '100.81.98.101' });
  assert.deepEqual(await identify(forwarded('100.64.9.9')), { key: 'ip:100.64.9.9', name: '', ip: '100.64.9.9' }, 'a node tailscale doesn\'t list');
  assert.deepEqual(await clientIdentity(async () => null)(forwarded('100.64.0.31')), { key: 'ip:100.64.0.31', name: '', ip: '100.64.0.31' }, 'tailscale not answering');
  let asked = false;
  const loopback = await clientIdentity(async () => { asked = true; return status; })({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } });
  assert.deepEqual([loopback, asked], [{ key: 'ip:127.0.0.1', name: '', ip: '127.0.0.1' }, false], 'a loopback client asks no tailscale');
});

test("the gate refuses a foreign Host, and a foreign Origin on an upgrade, before it asks who the client is", async () => {
  const named = { ...node, name: 'studio.tail1234.ts.net' };
  const gate = (tailnetOn) => ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => named, tailnet: () => tailnetOn });
  const at = (g, headers, remote = '127.0.0.1') => g({ headers, socket: { remoteAddress: remote } });
  const off = gate(false);
  for (const host of ['127.0.0.1:4500', 'localhost', 'LOCALHOST:8501', '[::1]:4500']) assert.equal(await at(off, { host }), 'owner', host);
  // A rebound name resolves to loopback, and the tailnet name is nothing while the tailnet is off.
  for (const host of ['evil.example:4500', 'studio.tail1234.ts.net', '127.0.0.1.evil.example']) assert.equal(await at(off, { host }), 'host', host);
  const on_ = gate(true);
  assert.equal(await at(on_, { host: 'studio.tail1234.ts.net', ...served('100.70.1.2') }), 'owner');
  assert.equal(await at(on_, { host: 'Studio.tail1234.ts.net:8501', ...served('100.70.1.2') }), 'owner');
  assert.equal(await at(on_, { host: 'evil.example', ...served('100.70.1.2') }), 'host');
  assert.equal(await at(on_, { host: 'other.tail1234.ts.net', ...served('100.70.1.2') }), 'host');
  // The node's own tailnet addresses name it too, with or without a port; another tailnet address is foreign.
  assert.equal(await at(on_, { host: '100.81.98.101:8501', ...served('100.70.1.2') }), 'owner');
  assert.equal(await at(on_, { host: '[fd7a:115c:a1e0::8601:62c1]:8501', ...served('100.70.1.2') }), 'owner');
  assert.equal(await at(on_, { host: '100.70.1.2:8501', ...served('100.70.1.2') }), 'host');
  assert.equal(await at(off, { host: '100.81.98.101:8501' }), 'host');
  // An upgrade's Origin is held to the same names; a plain request's is crossSite's to judge.
  const upgrade = { upgrade: 'websocket', host: '127.0.0.1:4500' };
  assert.equal(await at(off, { ...upgrade, origin: 'http://localhost:4500' }), 'owner');
  assert.equal(await at(off, upgrade), 'owner');
  for (const origin of ['https://evil.example', 'null', 'invalid']) assert.equal(await at(off, { ...upgrade, origin }), 'host', origin);
  assert.equal(await at(on_, { ...upgrade, host: 'studio.tail1234.ts.net', origin: 'https://studio.tail1234.ts.net', ...served('100.70.1.2') }), 'owner');
  assert.equal(await at(on_, { ...upgrade, host: 'studio.tail1234.ts.net', origin: 'https://evil.example', ...served('100.70.1.2') }), 'host');
  assert.equal(await at(off, { host: '127.0.0.1', origin: 'https://evil.example' }), 'owner');
  // Tailscale not answering leaves the tailnet name unknown.
  const silent = ownerGate({ addresses: () => ['127.0.0.1'], node: async () => null, tailnet: () => true });
  assert.equal(await at(silent, { host: 'studio.tail1234.ts.net', ...served('100.70.1.2') }), 'unread');
  assert.equal(await at(silent, { host: '127.0.0.1' }), 'owner');
});
