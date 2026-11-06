import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutFolders, checkoutsDir, keepSpotlightOut } from './spotlight.mjs';

const freshHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spotlight-')));
const states = (home) => checkoutFolders(home).map(({ name, state }) => `${name} ${state}`);

test('the fix moves each checkout folder into checkouts.noindex and leaves a link at its old path, so stored paths still reach the files', () => {
  const home = freshHome();
  const state = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(path.join(state, 'worktrees', 'GH-1'), { recursive: true });
  fs.writeFileSync(path.join(state, 'worktrees', 'GH-1', 'file.txt'), 'kept');
  fs.mkdirSync(path.join(state, 'repos', 'owner', 'app'), { recursive: true });
  assert.deepEqual(states(home), ['repos move', 'worktrees move', 'try link']);

  const notes = keepSpotlightOut({ home, runs: [] });
  const dir = checkoutsDir(home);
  assert.equal(dir, path.join(state, 'checkouts.noindex'));
  assert.deepEqual(notes, [
    `moved ${path.join(state, 'repos')} into ${dir}; the old path links to it`,
    `moved ${path.join(state, 'worktrees')} into ${dir}; the old path links to it`,
    `made ${path.join(dir, 'try')}; ${path.join(state, 'try')} links to it`,
  ]);
  for (const name of ['repos', 'worktrees', 'try']) {
    assert.ok(fs.lstatSync(path.join(state, name)).isSymbolicLink());
    assert.ok(fs.statSync(path.join(dir, name)).isDirectory());
  }
  assert.equal(fs.readFileSync(path.join(state, 'worktrees', 'GH-1', 'file.txt'), 'utf8'), 'kept');
  assert.equal(fs.realpathSync(path.join(state, 'worktrees', 'GH-1')), path.join(dir, 'worktrees', 'GH-1'));
  assert.deepEqual(states(home), ['repos ok', 'worktrees ok', 'try ok']);
  assert.deepEqual(keepSpotlightOut({ home, runs: [] }), []);
});

test('the fix refuses while a board run is live, naming the runs, and moves the folders on a later run once none is', () => {
  const home = freshHome();
  const worktrees = path.join(home, '.claude', 'kickflip', 'worktrees');
  fs.mkdirSync(worktrees, { recursive: true });
  const notes = keepSpotlightOut({ home, runs: ['/shop w/A1 (Builder)', '/hub hub/GH-2 (Builder)'] });
  assert.deepEqual(notes, [`not moving repos, worktrees and try into ${checkoutsDir(home)} while these board runs are live: /shop w/A1 (Builder), /hub hub/GH-2 (Builder); kickflip doctor --fix moves them once they finish`]);
  assert.ok(!fs.lstatSync(worktrees).isSymbolicLink());
  assert.ok(!fs.existsSync(checkoutsDir(home)));
  keepSpotlightOut({ home, runs: [] });
  assert.ok(fs.lstatSync(worktrees).isSymbolicLink());
});

test('a dry run says what it would move and changes nothing', () => {
  const home = freshHome();
  const state = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(path.join(state, 'worktrees'), { recursive: true });
  assert.deepEqual(keepSpotlightOut({ home, runs: [], dryRun: true }), [
    `would make ${path.join(checkoutsDir(home), 'repos')} and link ${path.join(state, 'repos')} to it`,
    `would move ${path.join(state, 'worktrees')} into ${checkoutsDir(home)} and link the old path to it`,
    `would make ${path.join(checkoutsDir(home), 'try')} and link ${path.join(state, 'try')} to it`,
  ]);
  assert.ok(!fs.existsSync(checkoutsDir(home)));
  assert.ok(!fs.lstatSync(path.join(state, 'worktrees')).isSymbolicLink());
});

test('a folder the fix cannot move is left for the person: another link, a file, or a folder already in checkouts.noindex', () => {
  const home = freshHome();
  const state = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(path.join(checkoutsDir(home), 'worktrees'), { recursive: true });
  fs.mkdirSync(path.join(state, 'worktrees'));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(state, 'repos'));
  fs.writeFileSync(path.join(state, 'try'), '');
  assert.deepEqual(checkoutFolders(home).map(({ state: s, why }) => `${s} ${why}`), [
    `yours links to ${path.join(home, 'elsewhere')}, not ${path.join(checkoutsDir(home), 'repos')}`,
    `yours ${path.join(checkoutsDir(home), 'worktrees')} already exists`,
    'yours is a file, not a folder',
  ]);
  assert.deepEqual(keepSpotlightOut({ home, runs: [] }), [
    `left ${path.join(state, 'repos')}: links to ${path.join(home, 'elsewhere')}, not ${path.join(checkoutsDir(home), 'repos')}`,
    `left ${path.join(state, 'worktrees')}: ${path.join(checkoutsDir(home), 'worktrees')} already exists`,
    `left ${path.join(state, 'try')}: is a file, not a folder`,
  ]);
});

test('a link to checkouts.noindex whose folder is gone gets its folder back', () => {
  const home = freshHome();
  const state = path.join(home, '.claude', 'kickflip');
  keepSpotlightOut({ home, runs: [] });
  fs.rmSync(path.join(checkoutsDir(home), 'try'), { recursive: true });
  assert.deepEqual(states(home), ['repos ok', 'worktrees ok', 'try link']);
  assert.deepEqual(keepSpotlightOut({ home, runs: [] }), [`made ${path.join(checkoutsDir(home), 'try')}; ${path.join(state, 'try')} links to it`]);
  assert.deepEqual(states(home), ['repos ok', 'worktrees ok', 'try ok']);
});
