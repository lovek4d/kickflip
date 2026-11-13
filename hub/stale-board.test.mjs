import { home, web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePorts } from '../shared/test-helpers.mjs';

// The test's side of the stand-in board servers: each GETs /up?pid=<pid> once it listens, and new code that must wait
// GETs /release, answered once the test has called release(). → {port, up(): the next server's pid, release()}
async function signals(t) {
  const ups = [];
  const waiting = [];
  const held = [];
  let released = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/release') { if (released) res.end(); else held.push(res); return; }
    res.end();
    const pid = Number(url.searchParams.get('pid'));
    if (waiting.length) waiting.shift()(pid); else ups.push(pid);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return {
    port: server.address().port,
    up: () => (ups.length ? Promise.resolve(ups.shift()) : new Promise((resolve) => waiting.push(resolve))),
    release: () => { released = true; for (const res of held.splice(0)) res.end(); },
  };
}

// A stand-in board server at <pkg>/board/server.mjs: answers every request with its pid, and imports ./dep.mjs, whose
// text the test changes as an upgrade or pull would. A fresh kickflip folder whose manifest runs it as the board /shop.
// → {pkg, dir, shopPort}
async function shopSite(signalPort) {
  fs.rmSync(web, { recursive: true, force: true });
  const pkg = path.join(home, 'pkg');
  write(path.join(pkg, 'board', 'server.mjs'), `import http from 'node:http';
import './dep.mjs';
const server = http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid })));
server.listen(Number(process.env.PORT), '127.0.0.1', () => fetch('http://127.0.0.1:' + process.env.SIGNALS + '/up?pid=' + process.pid));
`);
  write(path.join(pkg, 'board', 'dep.mjs'), 'export const v = 1;\n');
  const dir = path.join(web, 'sites', 'shop');
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'data/cards.json' });
  write(path.join(dir, 'data', 'cards.json'), { items: [{ id: 'A1', title: 'One' }] });
  const [shopPort] = await freePorts(1);
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {
    shop: { title: 'Shop', dir, port: shopPort, env: { SIGNALS: String(signalPort) }, cmd: [process.execPath, path.join(pkg, 'board', 'server.mjs'), dir] },
  } });
  return { pkg, dir, shopPort };
}

test('a board server whose code changed on disk restarts once its board has no running builder, and its page reads restarting meanwhile', async (t) => {
  const signal = await signals(t);
  const { pkg, dir, shopPort } = await shopSite(signal.port);
  const builder = path.join(dir, 'data', 'agents', 'A1.json');
  write(builder, { started: new Date().toISOString(), label: 'Builder' });
  const clock = { ms: Date.parse('2026-11-13T12:00:00Z') };
  const hub = await inProcessHub(t, { now: () => clock.ms, codeRestarts: true });
  const pid = () => fetch(`http://127.0.0.1:${shopPort}/`).then((r) => r.json()).then((j) => j.pid);
  const first = await signal.up();
  await hub.reconcile();

  // The new code waits for the test's release before it listens, so its page can be caught while it restarts.
  write(path.join(pkg, 'board', 'dep.mjs'), `export const v = 2;\nawait fetch('http://127.0.0.1:' + process.env.SIGNALS + '/release');\n`);
  await hub.reconcile();
  assert.ok(hub.lines.includes('shop runs older code than its files; restarts once no builder runs'), 'the hub sees the stale server and waits on the builder');
  assert.equal(await pid(), first, 'a running builder keeps the old server');

  write(builder, { started: new Date().toISOString(), done: new Date().toISOString(), label: 'Builder' });
  await hub.reconcile();
  assert.ok(hub.lines.includes('shop runs older code than its files; restarting it'), 'the hub restarts the stale server');
  await hub.logged(/^shop exited/);
  const page = await fetch(`${hub.base}/shop/`, { headers: { accept: 'text/html' } });
  assert.match(await page.text(), /restarting · its code changed/);
  // docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md: the page tells the states apart by these.
  assert.equal(page.headers.get('x-kickflip-down'), 'code');
  const gone = await fetch(`${hub.base}/nowhere/api/board`);
  assert.deepEqual([gone.status, gone.headers.get('x-kickflip-down')], [404, 'removed']);

  // It starts again a second after it exited, the first step of its backoff.
  clock.ms += 999;
  await hub.reconcile();
  assert.equal(hub.lines.filter((l) => l.startsWith('started shop')).length, 1);
  clock.ms += 1;
  await hub.reconcile();
  assert.equal(hub.lines.filter((l) => l.startsWith('started shop')).length, 2);
  signal.release();
  const second = await signal.up();
  assert.notEqual(second, first);

  // Once restarted, it runs the code in its files, so the check that finds it up restarts nothing.
  await hub.reconcile();
  const answer = await fetch(`${hub.base}/shop/`);
  assert.deepEqual([answer.headers.get('x-kickflip-hub'), answer.headers.get('x-kickflip-down'), (await answer.json()).pid], ['1', null, second]);
  assert.equal(await pid(), second);
  assert.equal(hub.lines.filter((l) => l.includes('restarting it')).length, 1, 'the hub restarted the server once');
});

// docs/adr/2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md
test('with KICKFLIP_CODE_RESTARTS=off, as a try run\'s demo hub runs, a board server whose code changed keeps running', async (t) => {
  const signal = await signals(t);
  const { pkg, shopPort } = await shopSite(signal.port);
  const hub = await inProcessHub(t, { codeRestarts: false });
  const pid = () => fetch(`http://127.0.0.1:${shopPort}/`).then((r) => r.json()).then((j) => j.pid);
  const first = await signal.up();
  await hub.reconcile();
  write(path.join(pkg, 'board', 'dep.mjs'), 'export const v = 2;\n');
  await hub.reconcile();
  await hub.reconcile();
  assert.equal(await pid(), first);
  assert.ok(!hub.lines.some((l) => /older code than its files/.test(l)));
});
