import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeTests, passTests } from './worktree.mjs';
import { until } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-run-'));
  const old = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
  return new Promise(() => setInterval(() => {}, 1000));
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
  fs.writeFileSync(path.join(tree, 'slow.test.mjs'), "import test from 'node:test';\ntest('slow', () => new Promise((r) => setTimeout(r, 2000)));\ntest('after', () => {});\n");
  const r = await nodeTests(tree, { testLimit: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.pass, 1);
  assert.equal(r.hung, undefined);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /^slow\n.*slow\.test\.mjs:2:1\n  test timed out after 300ms/);
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
