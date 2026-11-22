// docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sweepLeftovers } from './leftovers.mjs';
import { at, git, commit, scratchRepo, branches, onOrch, onHome, read, write } from '../board/board-fixture.mjs';

const DAY = 86400_000;
const tree = (id) => at('kickflip', 'worktrees', id);
const closeOn = (id, closedAt) => {
  const file = at('waves', 'w', 'wave.json');
  const wave = read(file);
  write(file, { ...wave, items: wave.items.map((it) => (it.id === id ? { ...it, lane: 'done', lane_at: closedAt, closed_at: closedAt } : it)) });
};
const NOW = Date.now();
const age = (file, days) => { const t = new Date(NOW - days * DAY); fs.utimesSync(file, t, t); };

test("the sweep removes a closed task's clean worktree, and one holding unlanded work 14 days after its close, and leaves an open task's", async (t) => {
  onHome(t);
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.equal((await onOrch('builder', 'start', 'w/ENG-1', '--worktree', '--repo', repo)).code, 0);
  commit(tree('A1'), 'work.txt', 'built\n');
  closeOn('A1', new Date(Date.now() - 13 * DAY).toISOString());

  let swept = await sweepLeftovers();
  assert.deepEqual(swept.worktrees, []);
  assert.ok(fs.existsSync(tree('A1')), 'unlanded work stays until 14 days after the close');
  assert.ok(fs.existsSync(tree('ENG-1')));

  closeOn('A1', new Date(Date.now() - 15 * DAY).toISOString());
  closeOn('ENG-1', new Date().toISOString());
  swept = await sweepLeftovers();
  assert.deepEqual(swept.worktrees.sort(), [tree('A1'), tree('ENG-1')]);
  assert.equal(fs.existsSync(tree('A1')), false);
  assert.equal(fs.existsSync(tree('ENG-1')), false);
  assert.deepEqual(branches(repo).filter((b) => b.startsWith('me/')), []);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n\n').length, 1, 'git lists only the repo itself');
});

test("the sweep removes an archived task's worktree, a folder git no longer lists once it is a day old, and leaves a worktree no task's record names", async (t) => {
  onHome(t);
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  const file = at('waves', 'w', 'wave.json');
  const wave = read(file);
  const item = wave.items.find((it) => it.id === 'A1');
  write(file, { ...wave, items: wave.items.filter((it) => it !== item) });
  const closedAt = new Date().toISOString();
  write(at('kickflip', 'sites', 'orch', 'data', 'done-archive.json'), { cards: [{ key: 'w/A1', file: 'w', archived_at: closedAt, closed_at: closedAt, item: { ...item, lane: 'done', closed_at: closedAt } }] });
  write(path.join(tree('GH-5-home'), 'left.txt'), 'x');
  age(tree('GH-5-home'), 2);
  write(path.join(tree('T-6'), 'new.txt'), 'x');
  git(repo, 'worktree', 'add', '--quiet', '-b', 'unnamed', tree('orch-prototypes'), 'main');

  const swept = await sweepLeftovers();
  assert.deepEqual(swept.worktrees.sort(), [tree('A1'), tree('GH-5-home')]);
  assert.ok(fs.existsSync(tree('T-6')), 'a folder made in the last day may be a worktree being added');
  assert.ok(fs.existsSync(tree('orch-prototypes')));
});

test('the sweep deletes agent and failed-land logs older than 14 days, and leaves newer ones and every other log', async (t) => {
  onHome(t);
  const logs = at('kickflip', 'logs');
  const names = {
    old: ['builder-A1-2026-11-01T10-00-00-000Z.log', 'planner-A2-2026-11-01T10-00-00-000Z.log', 'visual-A1-x.log', 'reviewer-A1-x.log', 'lander-A1-x.log', 'helper-A1-x.log', 'rebase-A1-x.log', 'land-0f8fad5b-d9cb-469f-a165-70867728950e.tap', 'land-7c9e6679-7425-40de-944b-e07fc1f90ae7.log'],
    kept: ['builder-A1-new.log', 'land-6fa459ea-ee8a-3ca4-894e-db77e160355e.tap', 'script-x.log', 'hub.log', 'host-load-2026-11-01.jsonl'],
  };
  for (const name of [...names.old, ...names.kept]) write(path.join(logs, name), 'x');
  for (const name of [...names.old, ...names.kept.filter((n) => !n.includes('new') && !n.startsWith('land-'))]) age(path.join(logs, name), 15);

  const swept = await sweepLeftovers();
  assert.deepEqual(swept.logs.sort(), names.old.sort());
  assert.deepEqual(fs.readdirSync(logs).sort(), names.kept.sort());
});
