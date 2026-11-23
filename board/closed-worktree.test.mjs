// docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeClosedWorktree } from './worktree.mjs';
import { git, commit, scratchRepo, boardWorktree as worktree, branches, onOrch, launched, threadOf, write } from './board-fixture.mjs';

const BRANCH = 'me/orch/a1';
const close = () => onOrch('item', 'set', 'w/A1', '--done', '--text', 'Closed without landing.');
const kept = () => threadOf().filter((m) => m.line === 'worktree-kept').map((m) => m.text);

test('a task closing without a land removes the worktree its build kept, and its branch, when it holds no work', async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.ok(fs.existsSync(worktree()));
  const r = await close();
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(worktree()), false);
  assert.equal(branches(repo).includes(BRANCH), false);
  assert.deepEqual(kept(), []);
});

test("a closing task's worktree holding commits that never landed, or uncommitted changes, stays with a thread line saying why", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n');
  write(path.join(worktree(), 'loose.txt'), 'not committed\n');
  assert.equal((await close()).code, 0);
  assert.ok(fs.existsSync(path.join(worktree(), 'work.txt')));
  assert.ok(branches(repo).includes(BRANCH));
  assert.deepEqual(kept(), ['Kept its worktree, removed in 14 days: 1 commit never landed and 1 changed file']);
});

test("a closing task's worktree stays while its launched build still runs, with a thread line saying so", async () => {
  const repo = scratchRepo();
  launched('orch', 'w/A1');
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.equal((await close()).code, 0);
  assert.ok(fs.existsSync(worktree()));
  assert.deepEqual(kept(), ['Kept its worktree, removed in 14 days: its build was still running']);
});

test('removeClosedWorktree counts the commits of a merged PR as landed, and force takes a worktree whatever it holds', async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  const tree = { path: worktree(), branch: BRANCH, repo };
  commit(worktree(), 'work.txt', 'built\n');
  assert.equal(await removeClosedWorktree(tree, { base: 'main' }), '1 commit never landed');
  assert.equal(await removeClosedWorktree(tree, { base: 'main', landed: true }), null);
  assert.equal(fs.existsSync(worktree()), false);
  assert.equal(branches(repo).includes(BRANCH), false);

  git(repo, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree(), 'main');
  commit(worktree(), 'work.txt', 'built again\n');
  write(path.join(worktree(), 'loose.txt'), 'not committed\n');
  assert.equal(await removeClosedWorktree(tree, { base: 'main', landed: true }), '1 changed file');
  assert.equal(await removeClosedWorktree(tree, { base: 'main', force: true }), null);
  assert.equal(fs.existsSync(worktree()), false);
  assert.equal(branches(repo).includes(BRANCH), false);
  assert.equal(await removeClosedWorktree(tree, { base: 'main' }), null, 'a worktree already gone is nothing to keep');
});
