import { home, web, write, inProcessHub, serverSignals } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePorts } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md
test("a starting New board's site runs and answers at its route before its orchestrator joins, its join keeps the same server running, and Dismiss stops it", async (t) => {
  const signals = await serverSignals(t);
  const pkg = path.join(home, 'pkg');
  write(path.join(pkg, 'board', 'server.mjs'), `import http from 'node:http';
http.createServer((req, res) => res.end('board ' + req.url)).listen(Number(process.env.PORT), '127.0.0.1');
`);
  const dir = path.join(web, 'sites', 'shop');
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'data/items.json' });
  const [port] = await freePorts(1);
  const site = { dir, port, cmd: [process.execPath, ...signals.args, path.join(pkg, 'board', 'server.mjs'), dir] };
  const manifest = path.join(web, 'manifest.json');
  const starting = { title: 'Shop', branch: 'main', phase: 'starting', asked_at: new Date().toISOString(), site };
  write(manifest, { version: 1, migrated: ['hub-flag'], sites: {}, starting: { shop: starting } });
  const hub = await inProcessHub(t, { codeRestarts: false });
  await signals.up();
  await hub.reconcile();
  const answer = await fetch(`${hub.base}/shop/api/board`);
  assert.equal(await answer.text(), 'board /api/board');

  // The join records the same site as the route's entry, the start staying until the board listens.
  write(manifest, { version: 1, migrated: ['hub-flag'], sites: { shop: { ...site, title: 'Shop', owner: { session: 's1' } } }, starting: { shop: { ...starting, joined_at: new Date().toISOString() } } });
  await hub.reconcile();
  await hub.reconcile();
  assert.equal(hub.lines.filter((l) => l.startsWith('started shop')).length, 1, 'one server, never restarted at the join');
  assert.ok(!hub.lines.some((l) => /shop entry changed/.test(l)));
  assert.equal(await (await fetch(`${hub.base}/shop/api/board`)).text(), 'board /api/board');

  write(manifest, { version: 1, migrated: ['hub-flag'], sites: {} });
  await hub.reconcile();
  await hub.logged(/^shop left the manifest; stopping it/);
  assert.equal((await fetch(`${hub.base}/shop/api/board`)).status, 404);
  fs.rmSync(web, { recursive: true, force: true });
});
