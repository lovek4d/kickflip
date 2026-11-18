// docs/adr/2026-11-18-0900-test-chrome-starts-no-crash-helpers-and-ends-with-its-group.md
// Needs a real headless Chrome, so it is skipped where none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromePath, startChrome } from './chrome.mjs';
import { tempDir } from './temp-dir.mjs';

const skip = !fs.existsSync(chromePath()) && 'no Chrome';
// Every process whose command line names the profile dir: Chrome, its children and any crash helper.
const withProfile = (dir) => {
  try { return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; }
};

test('a started Chrome has no crash helper, none holds the worktree as its cwd, and stop ends them all', { skip }, async () => {
  const dir = fs.realpathSync(tempDir('chrome-group-'));
  const chrome = await startChrome(dir);
  try {
    const pids = withProfile(dir);
    assert.ok(pids.length > 0, 'Chrome runs against the profile');
    const all = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    assert.ok(!/crashpad_handler|--crash-handler/.test(all.split('\n').filter((l) => l.includes(dir)).join('\n')), 'no crash helper names the profile');
    const cwds = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], { encoding: 'utf8' });
    assert.ok(!cwds.includes(process.cwd()), 'no Chrome process has its cwd in the worktree');
  } finally { await chrome.stop(); }
  assert.deepEqual(withProfile(dir), [], 'no process of the profile outlives stop');
  fs.rmSync(dir, { recursive: true, force: true });
});
