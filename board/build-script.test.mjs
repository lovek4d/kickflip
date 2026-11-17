import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildScriptError, listBuildTargets, listKickflipTargets, readScript, scriptFileOf, scriptShownOf, scriptsOf, writeScript } from './build-script.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
test("a board's scripts run from the worktree's .kickflip/ while its board.json says repo, and from its site's scripts/ while it says kickflip", () => {
  const site = tempDir('scripts-site-');
  assert.deepEqual(scriptsOf(site), { dir: site, scripts: 'repo' }, 'no board.json: the repo');
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ scripts: 'repo' }));
  const repo = scriptsOf(site);
  assert.deepEqual([scriptFileOf(repo, 'build-web', '/w'), scriptShownOf(repo, 'release')], ['/w/.kickflip/build-web', '.kickflip/release']);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ scripts: 'kickflip' }));
  const kickflip = scriptsOf(site);
  assert.equal(kickflip.scripts, 'kickflip');
  assert.deepEqual([scriptFileOf(kickflip, 'build', '/w'), scriptShownOf(kickflip, 'release')], [path.join(site, 'scripts', 'build'), path.join(site, 'scripts', 'release')]);
});

test('script set writes a kickflip-held script mode 0700, which the build script checks pass, and a save replaces it; show reads it back', () => {
  const site = tempDir('scripts-site-');
  assert.throws(() => readScript(site, 'build'), /no build script in kickflip; write one with script set build --file <file>/);
  const file = writeScript(site, 'build-web', '#!/bin/sh\necho port 1\n');
  assert.equal(file, path.join(site, 'scripts', 'build-web'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o700);
  assert.equal(buildScriptError(file), null);
  writeScript(site, 'build-web', '#!/bin/sh\necho port 2\n');
  assert.equal(readScript(site, 'build-web'), '#!/bin/sh\necho port 2\n');
  assert.deepEqual(fs.readdirSync(path.join(site, 'scripts')), ['build-web'], 'no history or temp file is left');
  for (const bad of ['serve', '../build', 'build-', 'build-a/b']) assert.throws(() => writeScript(site, bad, 'x'), /a board's scripts are build, build-<target> and release/, bad);
  assert.throws(() => writeScript(site, 'release', '  \n'), /needs the script's text/);
});

test('listKickflipTargets lists each executable build-<target> in the scripts folder, sorted, and none with no folder', () => {
  const site = tempDir('scripts-site-');
  assert.deepEqual(listKickflipTargets(site), []);
  writeScript(site, 'build-web', '#!/bin/sh\n');
  writeScript(site, 'build-iOS', '#!/bin/sh\n');
  writeScript(site, 'build', '#!/bin/sh\n');
  writeScript(site, 'release', '#!/bin/sh\n');
  fs.writeFileSync(path.join(site, 'scripts', 'build-docs'), '#!/bin/sh\n', { mode: 0o644 });
  assert.deepEqual(listKickflipTargets(site), ['iOS', 'web']);
});

// docs/adr/2026-11-13-2231-build-targets-wait-on-git.md
test('listBuildTargets asks git for the tree at ref with no time limit and lists each executable build-<target>, sorted', async () => {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push([file, args, opts.timeout]);
    return { stdout: ['100755 blob a1\tbuild-web', '100644 blob b2\tbuild-docs', '100755 blob c3\tbuild-iOS', '100755 blob d4\tbuild', '100755 blob e5\tbuild-bad name', ''].join('\n') };
  };
  assert.deepEqual(await listBuildTargets('/r', 'main', { run }), ['iOS', 'web']);
  assert.deepEqual(calls, [['git', ['-C', '/r', 'ls-tree', 'main:.kickflip'], undefined]]);
});

test('listBuildTargets lists none when git cannot read the tree, or the board has no repo', async () => {
  assert.deepEqual(await listBuildTargets('/r', 'main', { run: async () => { throw new Error('not a tree'); } }), []);
  assert.deepEqual(await listBuildTargets(null, 'main', { run: async () => { throw new Error('never run'); } }), []);
});
