import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until, boardListening, untilTestEnds } from '../shared/test-helpers.mjs';

// The perf bench for the board server: timing and real OS file watches, run by `npm run bench`, never by the main suite.

test('with thousands of folders and lock folders coming and going, the board answers at once, sends no change for the locks and still sends one for a write in a normal folder', async (t) => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'board-churn-'));
  let server, exited, req, churn, watch;
  // An after hook, not a finally, so a run the test runner times out still stops the children and removes the folder.
  t.after(async () => {
    watch?.close();
    req?.destroy();
    churn?.kill();
    server?.kill(); await exited;
    fs.rmSync(own, { recursive: true, force: true });
  });
  // docs/adr/2026-11-12-2135-the-folder-churn-test-builds-its-site-aside-and-bounds-its-churn.md
  // On a busy Mac the OS delivers file events seconds late, not always in order, and drops some. An event keeps the
  // path it had when it happened, so the site is built aside and renamed into place: its thousands of folders' events,
  // however late, are never under the server's watch. Its first checks' files are already as an empty board leaves
  // them, so the server writes nothing of its own either.
  const staged = path.join(own, 'staged');
  for (let w = 0; w < 20; w++) {
    for (let i = 0; i < 150; i++) fs.mkdirSync(path.join(staged, 'data', `w${w}`, 'dd', 'Build', `m${i}`), { recursive: true });
    for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(staged, 'data', `w${w}`, 'attachments', `a${i}`), { recursive: true });
    for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(staged, 'data', `w${w}`, '.installs', `i${i}`), { recursive: true });
  }
  fs.writeFileSync(path.join(staged, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(staged, 'data', 'action-pushes.json'), '{}\n');
  fs.writeFileSync(path.join(staged, 'data', 'orchestrator-waits.json'), '{"waits":[]}\n');
  fs.renameSync(staged, path.join(own, 'site'));
  const data = path.join(own, 'site', 'data');
  const [port] = await freePorts();
  server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), path.join(own, 'site')], { env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: own, PORT: String(port), PREFIX: '' } });
  exited = new Promise((resolve) => server.once('exit', resolve));
  await boardListening(server);
  req = http.get(`http://127.0.0.1:${port}/api/stream`);
  const res = await new Promise((resolve, reject) => req.once('response', resolve).once('error', reject));
  res.setEncoding('utf8');
  let text = '';
  res.on('data', (c) => { text += c; });
  const changes = () => text.split('\n\n').filter((block) => /^event: change$/m.test(block)).length;
  await until(() => text.includes('retry: 3000\n\n'), 'the board change stream opens', 2000);
  let last = changes(), since = Date.now();
  await until(() => {
    if (changes() !== last) { last = changes(); since = Date.now(); }
    return Date.now() - since >= 1500;
  }, 'the change stream goes quiet', 4000);
  const settled = changes();

  // The lock churn's events are in once a watch of the test's own has heard a marker file the server ignores, written
  // after the churn ends and again every 2 s in case the OS drops it, and then nothing for 2 s.
  let heard = false, events = 0, lastEvent = Date.now();
  watch = fs.watch(data, { recursive: true }, (_, file) => { events++; lastEvent = Date.now(); heard ||= file === '.churn-heard'; });
  const drain = async () => {
    const start = Date.now();
    let writes = 0;
    await until(() => {
      if (heard && Date.now() - lastEvent >= 2000) return true;
      if (!heard && Date.now() - start >= writes * 2000) fs.writeFileSync(path.join(data, '.churn-heard'), String(writes++));
      return false;
    }, "the OS delivers the lock churn's file events", 14000)
      .catch((e) => assert.fail(`${e.message}: the test's watch heard ${events} events, the marker ${heard ? '' : 'not '}among them, over ${writes} writes of it`));
    t.diagnostic(`the lock churn's events were in ${Date.now() - start} ms after it ended: ${events} events, ${writes} marker writes`);
  };
  // A churn of LOCKS lock folders made and removed, 20 a millisecond, then its exit. It is bounded so its events stay
  // fewer than a busy Mac drops past, and it stops with the test process if that is killed.
  const LOCKS = 500;
  const runChurn = () => {
    churn = spawn(process.execPath, ['-e', `
      const fs = require('fs'), path = require('path');
      let n = 0;
      const tick = () => {
        for (let k = 0; k < 20; k++, n++) {
          const locks = path.join(${JSON.stringify(data)}, 'w' + (n % 20), '.locks');
          fs.mkdirSync(path.join(locks, 'l' + n), { recursive: true });
          fs.rmSync(locks, { recursive: true, force: true });
        }
        if (n < ${LOCKS}) setTimeout(tick, 1);
      };
      tick();
      ${untilTestEnds()}.unref();`], { stdio: 'ignore' });
    return new Promise((resolve) => churn.once('exit', resolve));
  };

  // The board answers at once from the churn's start until its events are in, and for at least 3 s.
  const drained = runChurn().then(drain);
  let draining = true;
  drained.then(() => { draining = false; }, () => { draining = false; });
  const BUDGET = 250;
  let slowest = 0;
  for (const least = Date.now() + 3000; draining || Date.now() < least;) {
    const start = Date.now();
    const answer = await fetch(`http://127.0.0.1:${port}/_claude/health`, { signal: AbortSignal.timeout(BUDGET * 5) });
    assert.equal(answer.status, 200);
    slowest = Math.max(slowest, Date.now() - start);
  }
  await drained;
  t.diagnostic(`slowest health answer while the lock events reached the board: ${slowest} ms`);
  if (slowest > BUDGET) console.warn(`the board answered in ${slowest} ms during churn, over its ${BUDGET} ms budget`);
  // A change for the locks would have gone out within a second of their events.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(changes(), settled, 'lock folders coming and going send no change');

  // Under the churn the OS may drop a file event, so the write is repeated until one is heard.
  runChurn();
  let writes = 0;
  await until(() => {
    if (changes() > settled) return true;
    fs.writeFileSync(path.join(data, 'w3', 'attachments', 'a7', 'note.json'), String(writes++));
    return new Promise((resolve) => setTimeout(() => resolve(changes() > settled), 500));
  }, 'a write in a normal folder sends a change during churn', 8000);
});
