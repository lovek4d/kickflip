import { inProcessHub } from './hub-fixture.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { appHeaders } from './try.mjs';

const post = (hub, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: hub.port, path: '/_hub/build', method: 'POST', headers: { ...headers, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end('{}');
});

test('a request the try relay hands to a hub is refused by its loopback-only routes, as a local process’s is not', async (t) => {
  const hub = await inProcessHub(t);
  const visitor = { headers: { host: 'studio.tail1234.ts.net:8500', origin: 'https://studio.tail1234.ts.net:8500', 'content-length': '2' } };
  assert.equal(await post(hub, appHeaders(visitor, hub.port)), 403);
  const noOrigin = { headers: { host: 'studio.tail1234.ts.net:8500', 'content-length': '2' } };
  assert.equal(await post(hub, appHeaders(noOrigin, hub.port)), 403);
  assert.notEqual(await post(hub, { host: `127.0.0.1:${hub.port}` }), 403, 'a local process still gets through');
});
