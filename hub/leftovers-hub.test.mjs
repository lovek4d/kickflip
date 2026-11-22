// docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
import { home, web, bin, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const git = (cwd, ...args) => {
  const r = spawnSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

test('the hub answers requests while a sweep waits on a slow git', async (t) => {
  const hub = await inProcessHub(t);
  const repo = path.join(home, 'sweep-repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'maintenance.auto', 'false');
  git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'base');
  const tree = path.join(web, 'worktrees', 'S1');
  git(repo, 'worktree', 'add', '--quiet', '-b', 's1', tree, 'main');
  const site = path.join(web, 'sites', 'sweep');
  const now = new Date().toISOString();
  write(path.join(site, 'board.json'), { title: 'Sweep', items: 'data/items.json', slug: 's' });
  write(path.join(site, 'data', 'items.json'), { items: [{ id: 'S1', title: 'fix: one', lane: 'done', lane_at: now, closed_at: now }] });
  write(path.join(site, 'data', 'agents', 'S1.json'), { started: now, done: now, worktree: { path: tree, branch: 's1', repo } });
  write(path.join(web, 'manifest.json'), { version: 1, sites: { sweep: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'] } } });
  // Each git the sweep runs takes a second.
  const stub = path.join(bin, 'git');
  fs.writeFileSync(stub, '#!/bin/sh\nsleep 1\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  t.after(() => fs.rmSync(stub, { force: true }));

  let swept = false;
  const sweeping = hub.sweep().then(() => { swept = true; });
  const answer = await fetch(`${hub.base}/_hub/api/hub`);
  assert.equal(answer.status, 200);
  assert.equal(swept, false, 'the hub answered while the sweep still ran');
  await sweeping;
  assert.equal(fs.existsSync(tree), false);
  await hub.logged(/swept 1 worktrees and 0 logs/);
});
