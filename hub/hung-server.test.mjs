import { home, web, write, inProcessHub, serverSignals } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePorts } from '../shared/test-helpers.mjs';

const { readRestarts, autoRestartsFile } = await import('./auto-restarts.mjs');

// A stand-in board server at <pkg>/board/server.mjs that listens and answers; whether the hub reads it as answering
// HTTP is the test's answers flag. A fresh kickflip folder whose manifest runs it as the board /shop. → {dir}
async function shopSite(args) {
  fs.rmSync(web, { recursive: true, force: true });
  const pkg = path.join(home, 'pkg');
  write(path.join(pkg, 'board', 'server.mjs'), `import http from 'node:http';
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
  const dir = path.join(web, 'sites', 'shop');
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'data/cards.json' });
  write(path.join(dir, 'data', 'cards.json'), { items: [{ id: 'A1', title: 'One' }] });
  const [port] = await freePorts(1);
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {
    shop: { title: 'Shop', dir, port, cmd: [process.execPath, ...args, path.join(pkg, 'board', 'server.mjs'), dir] },
  } });
  return { dir };
}

test("a board server that is up but hasn't answered for a minute restarts once no builder is open, once per outage, logged, and pushes only when it doesn't come back", async (t) => {
  const signals = await serverSignals(t);
  const { dir } = await shopSite(signals.args);
  const builder = path.join(dir, 'data', 'agents', 'A1.json');
  const clock = { ms: Date.parse('2026-11-15T12:00:00Z') };
  let answering = true;
  const hub = await inProcessHub(t, { now: () => clock.ms, codeRestarts: false, answers: async () => answering });
  const count = (prefix) => hub.lines.filter((l) => l.startsWith(prefix)).length;
  // A reconcile, which starts and probes the server, then the hung check, which the hub's 15 s clock runs.
  const pass = async () => { await hub.reconcile(); await hub.hung(); };
  // The hub stopped the server for the nth time; it starts again on the reconcile 1.5 s on. → the new server's pid
  const restarted = async (n) => {
    await hub.logged(/^shop exited/, n);
    clock.ms += 1500;
    await pass();
    return signals.up();
  };
  const first = await signals.up();
  await pass();

  answering = false;
  await pass();
  clock.ms += 59_000;
  await pass();
  assert.equal(count('started shop'), 1, 'under a minute, nothing restarts');

  write(builder, { started: new Date(clock.ms).toISOString(), label: 'Builder' });
  clock.ms += 1000;
  await pass();
  assert.ok(hub.lines.includes("shop hasn't answered for a minute; its restart waits, since a builder is open"));
  assert.deepEqual(readRestarts(), [], 'a held restart is no restart');

  write(builder, { started: new Date(clock.ms).toISOString(), done: new Date(clock.ms).toISOString(), label: 'Builder' });
  await pass();
  assert.ok(hub.lines.includes("shop hasn't answered for a minute; restarting it"));
  assert.notEqual(await restarted(1), first);
  assert.deepEqual(readRestarts().map((e) => [e.board, e.what, e.why, e.outcome]), [['shop', 'server', 'not answering', 'restarted']]);

  // The new server doesn't answer either: one restart per outage, then one push once it hasn't come back.
  await pass();
  clock.ms += 2 * 60_000;
  await pass();
  clock.ms += 60_000;
  await pass();
  assert.equal(count('started shop'), 2, 'one restart per outage');
  assert.deepEqual(readRestarts().map((e) => e.outcome), ['restarted', 'not back']);
  assert.equal(count("shop still doesn't answer after the hub restarted it"), 1);

  // It answers again, which ends the outage; the next one restarts it again, and coming back is logged.
  answering = true;
  await pass();
  answering = false;
  await pass();
  clock.ms += 60_000;
  await pass();
  await restarted(2);
  answering = true;
  await pass();
  assert.deepEqual(readRestarts().map((e) => e.outcome), ['restarted', 'not back', 'restarted', 'back']);
  fs.rmSync(autoRestartsFile(), { force: true });
});
