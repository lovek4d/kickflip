import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { passTests, repoRun } from './worktree.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-21-2310-a-land-runs-its-repos-own-test-script.md
function home(t) {
  const dir = tempDir('repo-tests-');
  const old = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; });
  return dir;
}
// A repo named name in dir with one commit holding files ({path: text}, a path ending in * written executable without it).
function repoWith(dir, name, files) {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@t');
  for (const [name, text] of Object.entries({ 'x.txt': 'x\n', ...files })) {
    const file = path.join(repo, name.replace(/\*$/, ''));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: name.endsWith('*') ? 0o755 : 0o644 });
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  return repo;
}
const repoHome = { scripts: 'repo' };
const lines = () => {
  const said = [];
  const words = (test) => async (text, extra) => { said.push({ test, text, ...extra }); };
  return { said, report: { start: words('start'), update: words('update'), end: words('end') } };
};

test("a repo's executable .kickflip/test runs whole in the worktree, handed the base, and a land's pass says its last line", async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'app', { '.kickflip/test*': '#!/bin/sh\necho "args: $*" > ran\npwd >> ran\necho noise\necho "12 tests passed"\n' });
  const said = [];
  const { said: reported, report } = lines();
  await passTests(repo, { say: (l) => said.push(l), runTests: repoRun({ home: repoHome, base: 'main', say: (l) => said.push(l) }), outcome: 'nothing landed', report });
  const ran = fs.readFileSync(path.join(repo, 'ran'), 'utf8').split('\n');
  assert.equal(ran[0], 'args: main');
  assert.equal(fs.realpathSync(ran[1]), fs.realpathSync(repo));
  assert.deepEqual(said, ['testing with .kickflip/test, handed main', '.kickflip/test passed: 12 tests passed']);
  assert.equal(reported[0].text, '.kickflip/test');
  assert.match(reported.at(-1).text, /^\.kickflip\/test passed in 0m \d+s: 12 tests passed$/);
  assert.equal(reported.at(-1).failed, 0);
});

test('a run with no base, the nightly suite, hands the test script no argument, so it runs everything', async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'app', { '.kickflip/test*': '#!/bin/sh\necho "[$#]" > ran\n' });
  const r = await repoRun({ home: repoHome })(repo);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, 'ran'), 'utf8'), '[0]\n');
});

test('a failing test script refuses the land with its exit and last lines, saves its output, and is never rerun on the base', async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'app', { '.kickflip/test*': '#!/bin/sh\nfor i in $(seq 1 30); do echo "line $i"; done\necho "FAIL: login" >&2\nexit 3\n' });
  const { said: reported, report } = lines();
  let rerun = false;
  const e = await passTests(repo, { say: () => {}, runTests: repoRun({ home: repoHome, base: 'main', say: () => {} }), outcome: 'nothing landed', report, onBaseRun: async () => { rerun = true; return { failedFiles: [], signatures: {} }; } }).catch((err) => err);
  assert.equal(rerun, false);
  const [first, second, ...rest] = e.message.split('\n');
  assert.equal(first, `tests failed in ${repo}; nothing landed`);
  assert.equal(second, '.kickflip/test exited 3');
  assert.equal(rest.at(-2), 'FAIL: login');
  assert.ok(rest.includes('line 30') && !rest.includes('line 1'), 'only its last lines');
  const log = rest.at(-1).match(/^Full test output: (.+)$/)?.[1];
  assert.match(fs.readFileSync(log, 'utf8'), /^line 1\n/);
  assert.match(reported.at(-1).text, /^\.kickflip\/test failed in 0m \d+s: FAIL: login$/);
  assert.equal(reported.at(-1).failed, 1);
});

test('a test script still running at the limit is killed with its whole process group, and the land refuses naming it', async (t) => {
  const dir = home(t);
  const pidFile = path.join(dir, 'child.pid');
  const repo = repoWith(dir, 'app', { '.kickflip/test*': `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nwait\n` });
  const e = await passTests(repo, { say: () => {}, runTests: repoRun({ home: repoHome, base: 'main', say: () => {}, limit: 2000 }), outcome: 'nothing landed' }).catch((err) => err);
  assert.match(e.message, /^tests hung past 2 seconds in \.kickflip\/test; nothing landed\nFull test output: /);
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  // The group was sent SIGKILL before the refusal, so its child is gone or only waits to be reaped.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(child)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(state === '' || state.startsWith('Z'), `the script's child still runs: ${state}`);
});

test("a repo with no test script and no test files refuses to land, naming where its script goes; a stub that exits 0 opts out and says so", async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'site', { 'page.txt': 'hi\n' });
  await assert.rejects(passTests(repo, { say: () => {}, runTests: repoRun({ home: repoHome, base: 'main', say: () => {} }), outcome: 'nothing landed' }),
    { message: 'no test command for site: add an executable .kickflip/test, handed the base; one that exits 0 lands untested' });
  const site = tempDir('repo-tests-site-');
  await assert.rejects(Promise.resolve().then(() => repoRun({ home: { dir: site, scripts: 'kickflip' }, base: 'main' })(repo)),
    { message: 'no test command for site: write one with board.mjs script set test, handed the base; one that exits 0 lands untested' });

  const stub = repoWith(dir, 'stubbed', { '.kickflip/test*': '#!/bin/sh\necho "no tests: a static site"\n' });
  const said = [];
  await passTests(stub, { say: (l) => said.push(l), runTests: repoRun({ home: repoHome, base: 'main', say: () => {} }), outcome: 'nothing landed' });
  assert.deepEqual(said, ['.kickflip/test passed: no tests: a static site']);
});

test("a board whose scripts are in kickflip runs its site's scripts/test, never the repo's", async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'app', { '.kickflip/test*': '#!/bin/sh\nexit 1\n' });
  const site = tempDir('repo-tests-site-');
  fs.mkdirSync(path.join(site, 'scripts'));
  fs.writeFileSync(path.join(site, 'scripts', 'test'), '#!/bin/sh\npwd > ran\necho kickflip-held\n', { mode: 0o700 });
  const said = [];
  const { said: reported, report } = lines();
  await passTests(repo, { say: (l) => said.push(l), runTests: repoRun({ home: { dir: site, scripts: 'kickflip' }, base: 'main', say: () => {} }), outcome: 'nothing landed', report });
  assert.deepEqual(said, ['scripts/test in kickflip passed: kickflip-held']);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(repo, 'ran'), 'utf8').trim()), fs.realpathSync(repo), 'run in the worktree');
  assert.match(reported.at(-1).text, /^scripts\/test in kickflip passed in/);
});

test('a test script the build script checks refuse is refused by name, not run', async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'app', { '.kickflip/test': '#!/bin/sh\nexit 0\n' });
  await assert.rejects(passTests(repo, { say: () => {}, runTests: repoRun({ home: repoHome, base: 'main', say: () => {} }), outcome: 'nothing landed' }),
    { message: '.kickflip/test must be executable.' });
});

test("a repo with node test files and no test script keeps the node run of the tests the change affects", async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'kf', { 'a.test.mjs': "import test from 'node:test';\ntest('a', () => {});\n" });
  fs.writeFileSync(path.join(repo, 'b.test.mjs'), "import test from 'node:test';\ntest('b', () => {});\n");
  const said = [];
  const r = await repoRun({ home: repoHome, base: 'main', say: (l) => said.push(l) })(repo);
  assert.deepEqual([r.ok, r.pass], [true, 1]);
  assert.deepEqual(said, ['testing the 1 test files the change affects']);
  const full = await repoRun({ home: repoHome })(repo);
  assert.equal(full.pass, 2, 'no base: every test file');
});

test("a long last line is clipped to fit the card's line", async (t) => {
  const dir = home(t);
  const repo = repoWith(dir, 'app', { '.kickflip/test*': `#!/bin/sh\necho "${'x'.repeat(200)}"\n` });
  const { said: reported, report } = lines();
  await repoRun({ home: repoHome, base: 'main', say: () => {} })(repo, { report });
  assert.ok(reported.at(-1).text.length <= 80, reported.at(-1).text);
  assert.match(reported.at(-1).text, /x…$/);
});
