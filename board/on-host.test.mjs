import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHost } from './on-host.mjs';

// tailscale serve forwards every tailnet request from 127.0.0.1 with the client's tailnet address in X-Forwarded-For.
const own = ['127.0.0.1', '::1', '100.81.98.101', 'fd7a:115c:a1e0::8601:62c1'];

test("a request is from the host when tailscale serve names one of the host's own addresses, or when it came straight to loopback", () => {
  const at = (headers, remote = '127.0.0.1') => fromHost({ headers, socket: { remoteAddress: remote } }, own);
  assert.equal(at({ 'x-forwarded-for': '100.81.98.101' }), true);
  assert.equal(at({ 'x-forwarded-for': 'fd7a:115c:a1e0::8601:62c1' }), true);
  assert.equal(at({ 'x-forwarded-for': '100.70.1.2' }), false);
  assert.equal(at({ 'x-forwarded-for': '100.81.98.101, 100.70.1.2' }), false);
  assert.equal(at({}), true);
  assert.equal(at({}, '::ffff:127.0.0.1'), true);
  assert.equal(at({}, '192.168.1.40'), false);
});
