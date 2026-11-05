import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { holdingLandLock, holdingTestSlot, joiningLand, landInTurn } from './worktree.mjs';

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

// docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: only the fast-forward of main holds the lock.
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commit = (dir, file, text, subject) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', subject); };
function scratch(dir) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  commit(repo, 'a.txt', 'a\n', 'base');
  const tree = { path: path.join(dir, 'wt'), branch: 'A1', repo, base: 'main', ref: 'A1' };
  git(repo, 'worktree', 'add', '--quiet', '-b', 'A1', tree.path, 'main');
  commit(tree.path, 'b.txt', 'b\n', 'A1: work');
  return tree;
}
const quiet = { say: () => {}, restart: () => null, boards: () => [], clone: os.tmpdir() };

test('a land runs its rebase and tests without the lock, so another card lands meanwhile', async (t) => {
  const dir = home(t);
  const tree = scratch(dir);
  const lock = path.join(dir, '.claude', 'kickflip', 'land.lock');
  const seen = [];
  await landInTurn(tree, { ...quiet, runTests: () => { seen.push(fs.existsSync(lock)); return { ok: true, pass: 1 }; } });
  assert.deepEqual(seen, [false]);
  assert.equal(git(tree.repo, 'show', 'main:b.txt'), 'b');
});

test('a land whose main moved while its tests ran rebases and tests again, then lands', async (t) => {
  const dir = home(t);
  const tree = scratch(dir);
  let runs = 0;
  const runTests = () => { if (++runs === 1) commit(tree.repo, 'c.txt', 'c\n', 'moved'); return { ok: true, pass: 1 }; };
  await landInTurn(tree, { ...quiet, runTests });
  assert.equal(runs, 2);
  assert.deepEqual([git(tree.repo, 'show', 'main:b.txt'), git(tree.repo, 'show', 'main:c.txt')], ['b', 'c']);
});

test('a held land whose tested commit is still on top of main lands without testing again; one main moved past is retested', async (t) => {
  const dir = home(t);
  let runs = 0;
  const said = [];
  const opts = { ...quiet, say: (l) => said.push(l), runTests: () => { runs++; return { ok: true, pass: 1 }; } };
  const tree = scratch(dir);
  await landInTurn(tree, { ...opts, hold: true });
  assert.equal(runs, 1);
  await landInTurn(tree, opts);
  assert.equal(runs, 1);
  assert.ok(said.includes('A1 was tested on main as it is now; not testing it again'), said.join('\n'));
  assert.equal(git(tree.repo, 'show', 'main:b.txt'), 'b');

  git(tree.repo, 'worktree', 'add', '--quiet', '-b', 'A2', path.join(dir, 'wt2'), 'main');
  const second = { ...tree, path: path.join(dir, 'wt2'), branch: 'A2', ref: 'A2' };
  commit(second.path, 'd.txt', 'd\n', 'A2: work');
  await landInTurn(second, { ...opts, hold: true });
  commit(tree.repo, 'e.txt', 'e\n', 'moved');
  await landInTurn(second, opts);
  assert.equal(runs, 3);
  assert.equal(git(tree.repo, 'show', 'main:d.txt'), 'd');
});

test('a land asked for a card already landing joins that land: it waits for it to end and lands nothing itself', async (t) => {
  home(t);
  const order = [];
  const first = joiningLand('#251', async () => { order.push('first start'); await sleep(300); order.push('first end'); return { said: 'landed' }; });
  await sleep(50);
  const second = joiningLand('#251', async () => { order.push('second ran'); });
  assert.deepEqual(await Promise.all([first, second]), [{ said: 'landed' }, { joined: true }]);
  assert.deepEqual(order, ['first start', 'first end']);
  // Another card does not join it.
  const other = await Promise.all([joiningLand('#1', () => sleep(100).then(() => 1)), joiningLand('#2', async () => 2)]);
  assert.deepEqual(other, [1, 2]);
});

test('a land waiting for the lock wakes when it frees, not on a timer', async (t) => {
  home(t);
  let freed = 0;
  const first = holdingLandLock('#1', async () => { await sleep(200); freed = Date.now(); });
  await sleep(50);
  let woke = 0;
  await Promise.all([first, holdingLandLock('#2', async () => { woke = Date.now(); })]);
  const ms = woke - freed;
  if (ms > 100) console.warn(`the waiter woke ${ms} ms after the lock freed`);
  assert.ok(ms < 1000, `the waiter woke ${ms} ms after the lock freed`);
});

test('lands from separate processes go first in, first out', { timeout: 20000 }, async (t) => {
  const dir = home(t);
  const log = path.join(dir, 'order');
  const worktree = new URL('./worktree.mjs', import.meta.url).href;
  const child = (card) => new Promise((resolve, reject) => {
    const script = `import(${JSON.stringify(worktree)}).then((m) => m.holdingLandLock(${JSON.stringify(card)}, async () => require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(card + '\n')})))`;
    const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, HOME: dir }, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${card} exited ${code}`))));
  });
  const queue = path.join(dir, '.claude', 'kickflip', 'land.queue');
  const queued = async (n) => { while ((fs.existsSync(queue) ? fs.readdirSync(queue).length : 0) < n) await sleep(20); };
  let release;
  const hold = holdingLandLock('#0', () => new Promise((r) => { release = r; }));
  const runs = [];
  for (const [i, card] of ['#1', '#2', '#3'].entries()) { runs.push(child(card)); await queued(i + 1); }
  release();
  await Promise.all([hold, ...runs]);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['#1', '#2', '#3']);
});

// docs/adr/2026-11-05-0100-one-full-suite-at-a-time-on-the-host.md: one full suite at a time across the host.
async function settled(ok, what) {
  const until = Date.now() + 30000;
  while (!ok()) { assert.ok(Date.now() < until, what); await sleep(10); }
}

test('a land whose suite finds the test slot taken waits for it, saying which card runs, with the land lock free meanwhile', async (t) => {
  const dir = home(t);
  const kick = path.join(dir, '.claude', 'kickflip');
  const tree = scratch(dir);
  let release;
  const holder = holdingTestSlot('B2', () => new Promise((r) => { release = r; }));
  await settled(() => release, 'the slot was never taken');
  const waited = [];
  const events = [];
  const run = landInTurn(tree, { ...quiet, hold: true, onWaitTests: (card) => waited.push(card), runTests: () => { events.push('suite'); return { ok: true, pass: 1 }; } });
  await settled(() => waited.length, 'the land never waited');
  assert.deepEqual(waited, ['B2']);
  assert.deepEqual(events, []);
  assert.equal(fs.existsSync(path.join(kick, 'land.lock')), false);
  release();
  await Promise.all([holder, run]);
  assert.deepEqual(events, ['suite']);
  assert.equal(fs.existsSync(path.join(kick, 'test.lock')), false);
});

test('the test slot is held around the suite only, and freed when the suite throws', async (t) => {
  const dir = home(t);
  const tree = scratch(dir);
  const slot = path.join(dir, '.claude', 'kickflip', 'test.lock');
  const seen = [];
  await landInTurn(tree, { ...quiet, hold: true, runTests: () => { seen.push(JSON.parse(fs.readFileSync(slot, 'utf8')).card); return { ok: true, pass: 1 }; } });
  assert.deepEqual(seen, ['A1']);
  assert.equal(fs.existsSync(slot), false);
  await assert.rejects(holdingTestSlot('A2', () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(slot), false);
});

test('test slot waiters go first in, first out, and a slot or ask left by a process that is gone is taken over', async (t) => {
  const dir = home(t);
  const kick = path.join(dir, '.claude', 'kickflip');
  const queue = path.join(kick, 'test.queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(kick, 'test.lock'), JSON.stringify({ card: '#9', pid: 2 ** 22 + 1, at: 'x' }));
  fs.writeFileSync(path.join(queue, '000000000000001-000000-4194305'), '');
  const order = [];
  let release;
  const hold = holdingTestSlot('#1', () => new Promise((r) => { release = r; }));
  await settled(() => release, 'the first never took the slot');
  const later = [];
  for (const card of ['#2', '#3', '#4']) {
    const before = fs.readdirSync(queue).length;
    later.push(holdingTestSlot(card, async () => { order.push(card); }));
    await settled(() => fs.readdirSync(queue).length > before, `${card} never queued`);
  }
  release();
  await Promise.all([hold, ...later]);
  assert.deepEqual(order, ['#2', '#3', '#4']);
});
