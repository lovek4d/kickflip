import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listBuildTargets } from './build-script.mjs';

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
