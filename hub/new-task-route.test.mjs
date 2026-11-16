// docs/adr/2026-11-16-0600-the-hubs-new-task-box-files-through-the-router.md
import { web, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const queue = () => JSON.parse(fs.readFileSync(path.join(web, 'route-queue.json'), 'utf8')).queue;
const post = (hub, route, body, headers = { 'content-type': 'application/json' }) => fetch(`${hub.base}${route}`, { method: 'POST', headers, body });

test("the hub page's upload stores a file on the hub, and its route call queues the task for the router with its intent and files", async (t) => {
  const hub = await inProcessHub(t);
  const up = await post(hub, '/_hub/api/upload', 'png', { 'content-type': 'image/png', 'x-filename': encodeURIComponent('shot 1.png') });
  assert.equal(up.status, 200);
  const file = await up.json();
  assert.match(file.url, /^uploads\/\d+-shot-1\.png$/);
  assert.equal(fs.readFileSync(path.join(web, 'data', file.url), 'utf8'), 'png');

  const r = await post(hub, '/_hub/route', JSON.stringify({ text: 'fix the basket', quick: true, files: [{ ...file, path: '/etc/passwd' }] }));
  assert.equal(r.status, 202);
  const [q] = queue();
  assert.deepEqual([q.text, q.fields, q.from], ['fix the basket', { quick: true }, { via: 'hub', by: 'love' }]);
  assert.deepEqual(q.files, [{ name: 'shot 1.png', url: file.url, type: 'image/png', size: 3 }]);

  assert.equal((await post(hub, '/_hub/route', JSON.stringify({ text: 'plan it', request: 'grill' }))).status, 202);
  assert.deepEqual(queue()[1].fields, { request: 'grill' });
  assert.equal((await post(hub, '/_hub/route', JSON.stringify({ text: 'x', request: 'nope' }))).status, 400);
  assert.equal((await post(hub, '/_hub/route', JSON.stringify({ text: '  ' }))).status, 400);
  assert.equal((await post(hub, '/_hub/route', '{}', { 'content-type': 'text/plain' })).status, 403);
});

// docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md
test("a route call under a send id is queued once, under that id, however often the page's outbox resends it", async (t) => {
  const hub = await inProcessHub(t);
  // The fixture's queue holds what earlier tests filed.
  const before = fs.existsSync(path.join(web, 'route-queue.json')) ? queue().length : 0;
  const body = JSON.stringify({ text: 'fix the basket', sendId: 'mwj0pk1c-5fyl9l' });
  assert.deepEqual([(await post(hub, '/_hub/route', body)).status, (await post(hub, '/_hub/route', body)).status], [202, 202]);
  assert.deepEqual(queue().slice(before).map((q) => [q.id, q.text]), [['mwj0pk1c-5fyl9l', 'fix the basket']]);
  assert.equal((await post(hub, '/_hub/route', JSON.stringify({ text: 'odd id', sendId: '../x' }))).status, 202);
  assert.notEqual(queue().at(-1).id, '../x', 'a send id that is no plain token is not taken as the id');
});
