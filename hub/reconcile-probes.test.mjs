import { home, web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePorts } from '../shared/test-helpers.mjs';

// A site whose stand-in server listens and, when quits is set, exits as soon as it does. → {port}
async function shop(quits) {
  fs.rmSync(web, { recursive: true, force: true });
  const script = path.join(home, 'server.mjs');
  write(script, `import http from 'node:http';
const server = http.createServer((req, res) => res.end('ok'));
server.listen(Number(process.env.PORT), '127.0.0.1', () => { if (${quits}) process.exit(1); });
`);
  const dir = path.join(web, 'sites', 'shop');
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'data/cards.json' });
  write(path.join(dir, 'data', 'cards.json'), { items: [{ id: 'A1', title: 'One' }] });
  const [port] = await freePorts(1);
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: { shop: { title: 'Shop', dir, port, cmd: [process.execPath, script] } } });
  return { port };
}

// docs/adr/2026-11-17-0500-reconcile-probes-each-board-once-a-pass-on-the-15-s-clock.md
test('a reconcile probes a board with a running server once', async (t) => {
  const { port } = await shop(false);
  const probes = [];
  const probe = (p) => { probes.push(p); return fetch(`http://127.0.0.1:${p}/`).then(() => true, () => false); };
  const hub = await inProcessHub(t, { codeRestarts: false, probe });
  await hub.reconcile();
  probes.length = 0;
  await hub.reconcile();
  assert.deepEqual(probes, [port]);
});

test('a board server that exits starts again on its own once its backoff is over, not waiting for the 15 s clock', async (t) => {
  await shop(true);
  const hub = await inProcessHub(t, { codeRestarts: false, ticks: true });
  await hub.logged(/^started shop/, 2);
  assert.ok(hub.lines.some((l) => /^shop exited/.test(l)));
});
