import { home, web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { freePorts } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-17-1500-a-board-server-restart-waits-for-the-old-servers-group-to-exit.md
// A stand-in board server that is slow to close: it hands its listening socket to a child in its process group and
// exits on SIGTERM, and the child keeps the port for LINGER_MS more. A new server started in that gap loses the port.
const LINGER_MS = 1500;

test('a board server restart waits for the old server\'s group to free the port, so the new server is not refused', async (t) => {
  const ups = [];
  const waiting = [];
  const signal = http.createServer((req, res) => {
    res.end();
    const pid = Number(new URL(req.url, 'http://x').searchParams.get('pid'));
    if (waiting.length) waiting.shift()(pid); else ups.push(pid);
  });
  await new Promise((resolve) => signal.listen(0, '127.0.0.1', resolve));
  t.after(() => { signal.closeAllConnections(); return new Promise((resolve) => signal.close(resolve)); });
  const up = () => (ups.length ? Promise.resolve(ups.shift()) : new Promise((resolve) => waiting.push(resolve)));

  fs.rmSync(web, { recursive: true, force: true });
  const pkg = path.join(home, 'pkg');
  write(path.join(pkg, 'board', 'server.mjs'), `import http from 'node:http';
import { fork } from 'node:child_process';
import './dep.mjs';
const server = http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid })));
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  const linger = fork(new URL('./linger.mjs', import.meta.url), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  linger.send('socket', server);
  linger.once('message', () => fetch('http://127.0.0.1:' + process.env.SIGNALS + '/up?pid=' + process.pid));
});
process.on('SIGTERM', () => process.exit(0));
`);
  write(path.join(pkg, 'board', 'linger.mjs'), `process.on('message', (m, socket) => { socket.on('connection', (c) => c.destroy()); process.send('held'); });
process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${LINGER_MS}));
`);
  write(path.join(pkg, 'board', 'dep.mjs'), 'export const v = 1;\n');
  const dir = path.join(web, 'sites', 'shop');
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'data/cards.json' });
  write(path.join(dir, 'data', 'cards.json'), { items: [{ id: 'A1', title: 'One' }] });
  const [port] = await freePorts(1);
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {
    shop: { title: 'Shop', dir, port, env: { SIGNALS: String(signal.address().port) }, cmd: [process.execPath, path.join(pkg, 'board', 'server.mjs'), dir] },
  } });

  const clock = { ms: Date.parse('2026-11-17T12:00:00Z') };
  const hub = await inProcessHub(t, { now: () => clock.ms, codeRestarts: true });
  const first = await up();
  await hub.reconcile();

  write(path.join(pkg, 'board', 'dep.mjs'), 'export const v = 2;\n');
  await hub.reconcile();
  assert.ok(hub.lines.includes('shop runs older code than its files; restarting it'));
  await hub.logged(/^shop exited/);

  // The leader has exited, its child still holds the port: the pass at the end of the backoff waits for it, then starts the server.
  const held = await new Promise((resolve) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false)); });
  assert.ok(held, 'the stand-in really holds the port past its leader');
  clock.ms += 1500;
  await hub.reconcile();
  const second = await up();
  assert.notEqual(second, first);
  assert.ok(!hub.lines.some((l) => l.includes('not started')), hub.lines.join('\n'));
  assert.equal(hub.lines.filter((l) => l.startsWith('shop exited')).length, 1, 'only the stopped server exited: the new one never lost the port');
});
