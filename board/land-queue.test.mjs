import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { holdingLandLock } from './worktree.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-queue-'));
  const old = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('a land that finds another card landing waits for it, saying whom, and lands when it finishes', async (t) => {
  const dir = home(t);
  const order = [];
  const waited = [];
  const first = holdingLandLock('#210', async () => { order.push('#210 start'); await sleep(300); order.push('#210 end'); });
  await sleep(50);
  const second = holdingLandLock('#250', async () => { order.push('#250'); }, { onWait: (card) => waited.push(card) });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['#210 start', '#210 end', '#250']);
  assert.deepEqual(waited, ['#210']);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'kickflip', 'land.lock')), false);
});

test('lands waiting on one another go in the order they asked', async (t) => {
  home(t);
  const order = [];
  const hold = holdingLandLock('#1', () => sleep(300));
  await sleep(50);
  const later = [];
  for (const card of ['#2', '#3', '#4']) {
    later.push(holdingLandLock(card, async () => { order.push(card); }));
    await sleep(20);
  }
  await Promise.all([hold, ...later]);
  assert.deepEqual(order, ['#2', '#3', '#4']);
});

test('a lock or queued ask left by a process that is gone is taken over', async (t) => {
  const dir = home(t);
  const kick = path.join(dir, '.claude', 'kickflip');
  fs.mkdirSync(path.join(kick, 'land.queue'), { recursive: true });
  fs.writeFileSync(path.join(kick, 'land.lock'), JSON.stringify({ card: '#9', pid: 2 ** 22 + 1, at: 'x' }));
  fs.writeFileSync(path.join(kick, 'land.queue', '000000000000001-4194305'), '');
  let ran = false;
  await holdingLandLock('#5', async () => { ran = true; });
  assert.equal(ran, true);
});
