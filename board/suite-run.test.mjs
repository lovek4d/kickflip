import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { HOST_BUSY, failingOnBase, nodeTests, passTests, testArgs, testConcurrency } from './worktree.mjs';
import { machineFile } from '../shared/machine-gate.mjs';
import { until } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md
function home(t) {
  const dir = tempDir('suite-run-');
  const old = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; });
  return dir;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The file blocks its own event loop, so its near-cutoff timer can't end it and only the run's cutoff does.
test('a suite still running at the run cutoff is killed with its whole process group, and the land refuses naming the file that hung, saving the partial output and the processes left', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(path.join(tree, 'board'), { recursive: true });
  const pidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(path.join(tree, 'board', 'hang.test.mjs'), `import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
test('hangs', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
`);
  fs.writeFileSync(path.join(tree, 'a-quick.test.mjs'), "import test from 'node:test';\ntest('quick', () => {});\n");
  const said = [];
  await assert.rejects(
    passTests(tree, { say: (l) => said.push(l), runTests: (d) => nodeTests(d, { limit: 8000 }), outcome: 'nothing landed' }),
    (e) => {
      const [first, logLine] = e.message.split('\n');
      assert.equal(first, 'tests hung past 8 seconds in board/hang.test.mjs; nothing landed');
      const log = logLine.match(/^Full test output: (.+)$/)?.[1];
      assert.equal(path.dirname(log), path.join(dir, '.claude', 'kickflip', 'logs'));
      const saved = fs.readFileSync(log, 'utf8');
      assert.match(saved, /^TAP version 13\n/);
      assert.match(saved, /ok \d+ - quick/);
      assert.match(saved, /# processes still running at the cutoff\n(.*\n)*.*board\/hang\.test\.mjs/);
      return true;
    });
  assert.deepEqual(said, []);
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  await until(() => !alive(grandchild), "the hung file's own child never died with its group");
});

test('a test that runs past the per-test limit fails as timed out, and the rest of the suite still runs', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'slow.test.mjs'), "import test from 'node:test';\ntest('slow', () => new Promise((r) => setTimeout(r, 4000)));\n");
  fs.writeFileSync(path.join(tree, 'after.test.mjs'), "import test from 'node:test';\ntest('after', () => {});\n");
  // The limit is long enough for the other file to start under load: on Node 22 it covers the file's start too.
  assert.ok(testArgs(2000, ['slow.test.mjs']).includes('--test-timeout=2000'));
  const r = await nodeTests(tree, { testLimit: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.pass, 1);
  assert.equal(r.hung, undefined);
  assert.equal(r.failures.length, 1);
  // Node 22 times out the whole file and names it; Node 26 times out the one test and names it.
  assert.match(r.failures[0], /^(slow|\S*slow\.test\.mjs)\n.*slow\.test\.mjs:\d+:\d+\n  test timed out after 2000ms/);
});

test('a test file still running past the per-file limit, held open after its tests or stuck before them, fails by name with what holds it, and the rest of the suite still passes', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'held.test.mjs'), "import test from 'node:test';\ntest('done', () => {});\nsetInterval(() => {}, 1000);\n");
  fs.writeFileSync(path.join(tree, 'stuck.test.mjs'), "import test from 'node:test';\nawait new Promise(() => setInterval(() => {}, 1000));\ntest('never', () => {});\n");
  fs.writeFileSync(path.join(tree, 'fine.test.mjs'), "import test from 'node:test';\ntest('fine', () => {});\n");
  // The file limit is long enough for the passing file to start under load.
  const r = await nodeTests(tree, { fileLimit: 4000, limit: 30000 });
  assert.equal(r.ok, false);
  assert.equal(r.hung, undefined);
  assert.equal(r.pass, 2);
  assert.deepEqual(r.failedFiles, ['held.test.mjs', 'stuck.test.mjs']);
  const failures = r.failures.toSorted();
  assert.equal(failures.length, 2);
  for (const [i, name] of ['held', 'stuck'].entries()) {
    assert.match(failures[i], new RegExp(`^\\S*${name}\\.test\\.mjs\\n.*${name}\\.test\\.mjs:\\d+:\\d+\\n  Error: test file still running after 4 seconds, held open by .*Timeout`));
  }
});

test("a test file still running near the run's cutoff ends before it, failing by name with what holds it and the commands it waits on, and the run still reports the rest", async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'waits.test.mjs'), `import test from 'node:test';
import { spawn } from 'node:child_process';
test('waits on a child', () => new Promise((resolve) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'slow-command'], { stdio: 'ignore' }).on('exit', resolve)));
`);
  fs.writeFileSync(path.join(tree, 'fine.test.mjs'), "import test from 'node:test';\ntest('fine', () => {});\n");
  // The file limit is past the run's cutoff, so only the cutoff ends the waiting file.
  const r = await nodeTests(tree, { limit: 16000, fileLimit: 60000 });
  assert.equal(r.hung, undefined);
  assert.equal(r.pass, 1);
  assert.deepEqual(r.failedFiles, ['waits.test.mjs']);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /^\S*waits\.test\.mjs\n.*waits\.test\.mjs:\d+:\d+\n  Error: test file still running near the run's 16-second cutoff after \d+ seconds, held open by .*ProcessWrap.*, waiting on .*-e setInterval\(\(\) => \{\}, 1000\) slow-command/);
});

test('a suite that passes resolves with its counts and saves no log', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'a.test.mjs'), "import test from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\n");
  assert.deepEqual(await nodeTests(tree), { ok: true, pass: 2, fail: 0 });
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'kickflip', 'logs')), false);
});

test('a child a passing test left running is killed as the run exits', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  const pidFile = path.join(dir, 'child.pid');
  fs.writeFileSync(path.join(tree, 'leaves.test.mjs'), `import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
test('leaves a child running', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
});
`);
  assert.deepEqual(await nodeTests(tree), { ok: true, pass: 1, fail: 0 });
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  await until(() => !alive(child), 'the child the test left never died');
});

test("a suite's tests get a failing tailscale stub, so no hub they start reaches the host's Tailscale", async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'env.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { tailscaleDaemon } from ${JSON.stringify(new URL('../shared/tailscale.mjs', import.meta.url).href)};
test('stub', () => assert.deepEqual(tailscaleDaemon(), { kind: 'cli', cli: '/usr/bin/false' }));
`);
  assert.deepEqual(await nodeTests(tree), { ok: true, pass: 1, fail: 0 });
});

test('a suite run starts at most half the cores of test files at once, and at least two', () => {
  assert.equal(testConcurrency(), Math.max(2, Math.floor(os.availableParallelism() / 2)));
  assert.ok(testArgs(1000, ['a.test.mjs']).includes(`--test-concurrency=${testConcurrency()}`));
});

// docs/adr/2026-11-14-1530-a-land-reruns-an-untouched-failing-test-on-main.md
test('a failing run names the test files holding a failing test', async (t) => {
  const dir = home(t);
  fs.writeFileSync(path.join(dir, 'bad.test.mjs'), "import test from 'node:test';\ntest('bad', () => { throw new Error('boom'); });\n");
  fs.writeFileSync(path.join(dir, 'good.test.mjs'), "import test from 'node:test';\ntest('good', () => {});\n");
  const r = await nodeTests(dir, { files: ['bad.test.mjs', 'good.test.mjs'] });
  assert.deepEqual(r.failedFiles, ['bad.test.mjs']);
});

// docs/adr/2026-11-17-0519-a-land-failing-on-mains-own-test-blocks-on-mains-fix.md
test("a land passes a run whose failing files fail on the base too, each untouched or failing there the same way; one failing differently is main's to fix first; one main passes is the change's", async (t) => {
  home(t);
  const run = (failed, touched) => () => ({ ok: false, fail: Object.keys(failed).length, failedFiles: Object.keys(failed), signatures: failed, touched, failures: ['x'] });
  const said = [];
  const asked = [];
  const base = (failed) => async (files) => { asked.push(files); return { failedFiles: Object.keys(failed), signatures: failed }; };
  await passTests('/wt', { say: (l) => said.push(l), runTests: run({ 'x.test.mjs': ['a'] }, ['y.test.mjs']), outcome: 'nothing landed', onBaseRun: base({ 'x.test.mjs': ['b'] }) });
  assert.deepEqual(asked, [['x.test.mjs']]);
  assert.match(said[0], /x\.test\.mjs fail on the base too/);
  await passTests('/wt', { say: (l) => said.push(l), runTests: run({ 'y.test.mjs': ['a', 'b'] }, ['y.test.mjs']), outcome: 'nothing landed', onBaseRun: base({ 'y.test.mjs': ['b', 'a'] }) });
  assert.match(said[1], /y\.test\.mjs fail on the base too/, 'a touched file failing as it does on the base');
  await passTests('/wt', { say: (l) => said.push(l), runTests: run({ 'y.test.mjs': ['a'] }, undefined), outcome: 'nothing landed', onBaseRun: base({ 'y.test.mjs': ['a'] }) });
  assert.match(said[2], /y\.test\.mjs fail on the base too/, 'a full run touches every file');

  const differs = await passTests('/wt', { runTests: run({ 'y.test.mjs': ['a', 'new'] }, ['y.test.mjs']), outcome: 'nothing landed', onBaseRun: base({ 'y.test.mjs': ['a'] }) }).catch((e) => e);
  assert.match(differs.message, /tests failed in \/wt/);
  assert.deepEqual(differs.failsOnBase, ['y.test.mjs'], 'main fails it too, so it waits on main\'s fix');
  const own = await passTests('/wt', { runTests: run({ 'x.test.mjs': ['a'], 'y.test.mjs': ['a'] }, ['y.test.mjs']), outcome: 'nothing landed', onBaseRun: base({ 'y.test.mjs': ['a'] }) }).catch((e) => e);
  assert.match(own.message, /tests failed in \/wt/);
  assert.equal(own.failsOnBase, undefined, 'x.test.mjs passes on the base, so the change broke it');
});

test('a failing run keys each failure by its file, the same wherever the run is checked out: no location, duration or stack', async (t) => {
  const dir = home(t);
  const sigs = [];
  for (const where of ['one', 'two']) {
    const tree = path.join(dir, where);
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, 'scan.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${where === 'two' ? '\n' : ''}test('scan', () => { assert.deepEqual([import.meta.dirname + ':3: bad'], [], 'use tempDir'); });\n`);
    sigs.push((await nodeTests(tree, { files: ['scan.test.mjs'] })).signatures);
  }
  assert.deepEqual(Object.keys(sigs[0]), ['scan.test.mjs']);
  assert.deepEqual(sigs[0], sigs[1]);
  assert.match(sigs[0]['scan.test.mjs'][0], /^scan\n/);
  assert.match(sigs[0]['scan.test.mjs'][0], /use tempDir/);
  assert.doesNotMatch(sigs[0]['scan.test.mjs'][0], /location|duration_ms|stack/);
});

test('failingOnBase runs the files on the base commit in a worktree of its own, and says which fail there and how', async (t) => {
  const dir = home(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(repo, 'bad.test.mjs'), "import test from 'node:test';\ntest('bad', () => { throw new Error('boom'); });\n");
  fs.writeFileSync(path.join(repo, 'good.test.mjs'), "import test from 'node:test';\ntest('good', () => {});\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const onBase = await failingOnBase(repo, 'main', ['bad.test.mjs', 'good.test.mjs']);
  assert.deepEqual(onBase.failedFiles, ['bad.test.mjs']);
  assert.match(onBase.signatures['bad.test.mjs'][0], /^bad\n/);
  assert.equal(git('worktree', 'list').trim().split('\n').length, 1, 'the rerun worktree is removed');
});

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
test('a test run waits while the host reads busy, saying so on its line, and starts once the host eases', async (t) => {
  const dir = home(t);
  const keep = (state) => { fs.mkdirSync(path.dirname(machineFile(dir)), { recursive: true }); fs.writeFileSync(machineFile(dir), JSON.stringify(state)); };
  keep({ state: 'busy', reason: 'memory pressure critical', since: '2026-11-14T10:00:00.000Z' });
  const steps = [];
  const report = { start: () => {}, end: () => {}, update: async (words) => { steps.push(`line: ${words}`); } };
  let reads = 0;
  // The host reads busy at the first recheck too, and eased at the second.
  const wait = async () => { steps.push('waited'); if (++reads === 2) keep({ state: 'normal' }); };
  const runTests = async () => { steps.push('ran'); return { ok: true, pass: 1 }; };
  await passTests('/wt', { say: (l) => steps.push(`said: ${l}`), runTests, outcome: 'nothing landed', report, wait });
  assert.deepEqual(steps, [`said: ${HOST_BUSY}`, `line: ${HOST_BUSY}`, 'waited', 'waited', 'ran', 'said: tests passed: 1']);
  assert.equal(HOST_BUSY, 'waiting: the host is busy');
  // docs/adr/2026-11-19-0242-a-bump-goes-first-in-every-queue.md: a bumped card's land tests at once.
  keep({ state: 'busy', reason: 'memory pressure critical', since: '2026-11-14T10:00:00.000Z' });
  steps.length = 0;
  await passTests('/wt', { say: (l) => steps.push(`said: ${l}`), runTests, outcome: 'nothing landed', report, wait, bumped: true });
  assert.deepEqual(steps, ['ran', 'said: tests passed: 1']);
});

test('a test run on a host that is not busy starts at once, without a waiting line', async (t) => {
  home(t);
  const steps = [];
  await passTests('/wt', { say: (l) => steps.push(l), runTests: async () => ({ ok: true, pass: 1 }), outcome: 'nothing landed', wait: () => assert.fail('nothing waits') });
  assert.deepEqual(steps, ['tests passed: 1']);
});

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// Every process the run's test starts holds the write end of a FIFO open and writes its pid on it; the read end sees
// its end once every writer is gone.
test('a run whose starter is killed mid-test leaves none of its processes running, detached or not', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  const fifo = path.join(dir, 'held');
  execFileSync('mkfifo', [fifo]);
  const stand = `const fs = require('node:fs'); fs.writeSync(fs.openSync(${JSON.stringify(fifo)}, 'w'), process.pid + '\\n'); setInterval(() => {}, 1 << 30);`;
  fs.writeFileSync(path.join(tree, 'hold.test.mjs'), `import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
test('holds', () => {
  spawn(process.execPath, ['-e', ${JSON.stringify(stand)}], { detached: true, stdio: 'ignore' }).unref();
  spawn(process.execPath, ['-e', ${JSON.stringify(stand)} + "require('node:child_process').spawn(process.execPath, ['-e', " + ${JSON.stringify(JSON.stringify(stand))} + "], { detached: true, stdio: 'ignore' });"], { stdio: 'ignore' });
  fs.writeSync(fs.openSync(${JSON.stringify(fifo)}, 'w'), process.pid + '\\n');
  return new Promise(() => setInterval(() => {}, 1 << 30));
});
`);
  // The test's own write end keeps the read end from seeing an end before the run's writers open theirs.
  const reader = fs.createReadStream(fifo, 'utf8');
  const own = await fs.promises.open(fifo, 'w');
  let heard = '';
  const ended = new Promise((resolve) => reader.on('end', resolve));
  const pids = new Promise((resolve) => reader.on('data', (d) => { heard += d; if (heard.split('\n').length > 4) resolve(heard.trim().split('\n').map(Number)); }));
  const starter = spawn(process.execPath, ['--input-type=module', '-e', `import { nodeTests } from ${JSON.stringify(new URL('./worktree.mjs', import.meta.url).href)}; await nodeTests(${JSON.stringify(tree)});`], { stdio: 'ignore' });
  // Should one survive, it is stopped, so its write end lets this file end.
  t.after(async () => { starter.kill('SIGKILL'); for (const pid of await pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  // The test file's process, the two it starts and the detached one the second starts.
  assert.equal((await pids).length, 4);
  starter.kill('SIGKILL');
  await own.close();
  await ended;
});

// docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
test('a test run makes its temp dirs in a folder of its own, which goes as the run ends, with what a killed test file left there', async (t) => {
  const dir = home(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  const made = path.join(dir, 'made.txt');
  const tempDirModule = new URL('../shared/temp-dir.mjs', import.meta.url).href;
  fs.writeFileSync(path.join(tree, 'killed.test.mjs'), `import test from 'node:test';
import fs from 'node:fs';
import { tempDir } from ${JSON.stringify(tempDirModule)};
test('killed', () => {
  fs.writeFileSync(${JSON.stringify(made)}, tempDir('killed-'));
  process.kill(process.pid, 'SIGKILL');
});
`);
  const result = await nodeTests(tree, { limit: 60_000 });
  assert.equal(result.ok, false);
  const run = path.dirname(fs.readFileSync(made, 'utf8'));
  assert.equal(fs.realpathSync(path.dirname(run)), fs.realpathSync(os.tmpdir()), "the run's folder is in the system temp dir");
  assert.equal(fs.existsSync(run), false, "the run's folder went with the run");
});
