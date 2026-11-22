// docs/adr/2026-11-18-0900-test-chrome-starts-no-crash-helpers-and-ends-with-its-group.md
// Needs a real headless Chrome, so it is skipped where none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { chromePath, startChrome, sweepOrphanChromes } from './chrome.mjs';
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

// docs/adr/2026-11-22-2350-a-test-files-headless-chrome-ends-with-it.md
// A node process that starts a Chrome and is then killed outright, as a run's cutoff kills a test file's group.
async function startedThenKilled() {
  const dir = fs.realpathSync(tempDir('chrome-ended-'));
  const code = `import { startChrome } from ${JSON.stringify(new URL('./chrome.mjs', import.meta.url).href)};
    await startChrome(${JSON.stringify(dir)}); console.log('started'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  assert.ok(withProfile(dir).length > 0, 'Chrome runs against the profile');
  const closed = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await closed;
  return dir;
}

test('a test file ended through process.exit leaves no Chrome behind', { skip }, async () => {
  const dir = fs.realpathSync(tempDir('chrome-ended-'));
  const code = `import { startChrome } from ${JSON.stringify(new URL('./chrome.mjs', import.meta.url).href)};
    await startChrome(${JSON.stringify(dir)}); process.exit(1);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.deepEqual(withProfile(dir), []);
});

test('a test file killed outright leaves a Chrome that the sweep ends', { skip }, async () => {
  const dir = await startedThenKilled();
  try {
    assert.ok(withProfile(dir).length > 0, 'a SIGKILL leaves its Chrome running');
    await sweepOrphanChromes();
    assert.deepEqual(withProfile(dir), []);
  } finally { await sweepOrphanChromes(); }
});

test('the sweep leaves a Chrome whose test file still runs', { skip }, async () => {
  const dir = fs.realpathSync(tempDir('chrome-live-'));
  const chrome = await startChrome(dir);
  try {
    await sweepOrphanChromes();
    assert.ok(withProfile(dir).length > 0);
  } finally { await chrome.stop(); }
});
