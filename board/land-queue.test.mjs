import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { holdingLandLock, joiningLand, landInTurn } from './worktree.mjs';

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
  commit(tree.path, 'b.txt', 'b\n', 'feat: work\n\nRefs: A1');
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
  commit(second.path, 'd.txt', 'd\n', 'feat: work\n\nRefs: A2');
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

// The waiter's 5 s recheck can never fire (setTimeout is mocked), so a waiter that finishes was woken by the watch or the
// immediate recheck, not the timer.
const noRecheck = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

test('a land waiting for the lock wakes when it frees, not on a timer', async (t) => {
  home(t);
  noRecheck(t);
  let release;
  const first = holdingLandLock('#1', () => new Promise((r) => { release = r; }));
  let ran = false;
  await Promise.all([first, holdingLandLock('#2', async () => { ran = true; }, { onWait: () => release() })]);
  assert.equal(ran, true);
});

// A free the instant a waiter starts watching, while other watches in the process open and close (on macOS each one
// restarts the process's shared directory-watch stream), still wakes the waiter.
function churnWatches(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-churn-'));
  const timer = setInterval(() => fs.watch(dir).close(), 1);
  t.after(() => { clearInterval(timer); fs.rmSync(dir, { recursive: true, force: true }); });
}

test('a lock freed the moment its waiter starts watching still wakes the waiter', async (t) => {
  home(t);
  churnWatches(t);
  noRecheck(t);
  for (let i = 0; i < 5; i++) {
    let release;
    const first = holdingLandLock('#1', () => new Promise((r) => { release = r; }));
    let ran = false;
    await Promise.all([first, holdingLandLock('#2', async () => { ran = true; }, { onWait: () => release() })]);
    assert.equal(ran, true);
  }
});

test('an ask ahead that leaves the moment its waiter starts watching still wakes the waiter', async (t) => {
  home(t);
  churnWatches(t);
  noRecheck(t);
  for (let i = 0; i < 5; i++) {
    let release;
    let left = false;
    const hold = holdingLandLock('#0', () => new Promise((r) => { release = r; }));
    const ahead = holdingLandLock('#1', async () => {});
    // #2 waits behind #1's ask; the lock frees the moment it starts waiting, so #1 takes it and its ask leaves.
    let ran = false;
    await Promise.all([hold, ahead, holdingLandLock('#2', async () => { ran = true; }, { onWait: () => { if (!left) { left = true; release(); } } })]);
    assert.equal(ran, true);
  }
});

test('a land that ends the moment another joins it still wakes the joiner', async (t) => {
  home(t);
  churnWatches(t);
  noRecheck(t);
  for (let i = 0; i < 5; i++) {
    let release;
    const first = joiningLand('#251', () => new Promise((r) => { release = r; }));
    const second = joiningLand('#251', async () => {});
    release();
    await first;
    assert.deepEqual(await second, { joined: true });
  }
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
