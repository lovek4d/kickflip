import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from '../shared/temp-dir.mjs';

const home = tempDir('nightly-suite-');
process.env.HOME = home;
const { suiteDue, runNightlySuite } = await import('./nightly-suite.mjs');
const { suiteStateFile } = await import('./boards.mjs');
const { overnightJobs, setOvernight } = await import('./overnight.mjs');
const { DEFAULTS } = await import('./schedule.mjs');

const t = (h, m = 0, day = 14) => new Date(2026, 9, day, h, m);
const SERVER = new URL('../board/server.mjs', import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A repo whose main holds one file naming it, and a board on it with no server listening, so events land in its file.
function board(name, repo = makeRepo(name)) {
  const dir = path.join(home, 'boards', name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ items: 'data/items.json' }));
  fs.writeFileSync(path.join(dir, 'data/items.json'), JSON.stringify({ items: [] }));
  return [name, { dir, port: 1, cmd: [process.execPath, SERVER], local: true, owner: { repo } }];
}
function makeRepo(name) {
  const repo = path.join(home, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'which.txt'), name);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'which.txt'), 'uncommitted');
  return repo;
}
const asks = (dir) => {
  const file = path.join(dir, 'data', 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'ask') : [];
};
const failing = { ok: false, pass: 10, fail: 2, failures: ['a > breaks\n  board/a.test.mjs:3:1\n  AssertionError: no'], log: '/logs/land-1.tap', error: 'test runner exited 1' };
const passing = { ok: true, pass: 12, fail: 0 };
const eases = async () => {};

test('a night whose run had files cut off by its limit lists them with its failures', async () => {
  fs.rmSync(suiteStateFile(), { force: true });
  const sites = Object.fromEntries([board('cut')]);
  const cut = { ...failing, failures: [], cutOff: { after: '15 minutes', files: ['board/slow.test.mjs'], failures: ["board/slow.test.mjs\n  Error: test file still running near the run's 15-minute cutoff"] } };
  await runNightlySuite({ now: t(3, 1), settings: DEFAULTS, manifest: { sites }, runTests: async () => cut, eases });
  const [filed] = asks(sites.cut.dir);
  assert.match(filed.data.text, /^- board\/slow\.test\.mjs\n  Error: test file still running near the run's 15-minute cutoff$/m);
});

test('the nightly suite is due once a night, from the middle of quiet hours to their end', () => {
  assert.equal(suiteDue(t(2, 59), DEFAULTS), null);
  assert.equal(suiteDue(t(3), DEFAULTS), '2026-10-14');
  assert.equal(suiteDue(t(7, 59), DEFAULTS, { night: '2026-10-14' }), null);
  assert.equal(suiteDue(t(8), DEFAULTS), null);
  assert.equal(suiteDue(t(3, 0, 15), DEFAULTS, { night: '2026-10-14' }), '2026-10-15');
  assert.equal(suiteDue(t(3), { ...DEFAULTS, quiet: { ...DEFAULTS.quiet, start: '01:00', end: '05:00' } }), '2026-10-14');
});

test("every board's main runs one at a time, on a clean checkout of main; a failure files a task on that board, and its row links it", async () => {
  fs.rmSync(suiteStateFile(), { force: true });
  const sites = Object.fromEntries([board('alpha'), board('beta'), board('nofolder', '')]);
  const manifest = { sites };
  let running = 0;
  const seen = [];
  const runTests = async (dir) => {
    assert.equal(running++, 0, 'one board at a time');
    seen.push(fs.readFileSync(path.join(dir, 'which.txt'), 'utf8'));
    await new Promise(setImmediate);
    running--;
    return seen.at(-1) === 'beta' ? failing : passing;
  };
  const r = await runNightlySuite({ now: t(3, 1), settings: DEFAULTS, manifest, runTests, eases });
  assert.deepEqual(seen, ['alpha', 'beta'], 'main as committed, not the folder\'s uncommitted change');
  assert.deepEqual(r.runs.map((x) => [x.route, x.ok]), [['alpha', true], ['beta', false], ['nofolder', false]]);
  assert.equal(asks(sites.alpha.dir).length, 0);
  const [filed] = asks(sites.beta.dir);
  assert.match(filed.data.text, /^Nightly full suite failed on main at [0-9a-f]{7,}: 2 of 12 tests failed\./);
  assert.match(filed.data.text, /a > breaks/);
  assert.match(filed.data.text, /Full output: \/logs\/land-1\.tap/);
  assert.equal(asks(sites.nofolder.dir).length, 0, "a board that couldn't run files nothing");
  assert.deepEqual(fs.readdirSync(path.join(home, 'repos', 'beta')).sort(), ['.git', 'which.txt']);
  assert.equal(git(path.join(home, 'repos', 'beta'), 'worktree', 'list').split('\n').length, 1, 'the checkout is removed');

  const row = overnightJobs().find((j) => j.id === 'suite');
  assert.equal(row.on, true);
  assert.deepEqual(row.last, { at: t(3, 1).toISOString(), failed: "failed on beta; couldn't run on nofolder", href: `/beta/#selectedCard=${encodeURIComponent(`ask:${filed.id}`)}` });

  assert.equal(await runNightlySuite({ now: t(4), settings: DEFAULTS, manifest, runTests, eases }), null, 'once a night');
});

test('boards on one repo and branch run it once, and a clean night reads ok', async () => {
  fs.rmSync(suiteStateFile(), { force: true });
  const repo = makeRepo('shared');
  const sites = Object.fromEntries([board('one', repo), board('two', repo)]);
  let runs = 0;
  const r = await runNightlySuite({ now: t(3), settings: DEFAULTS, manifest: { sites }, runTests: async () => { runs++; return passing; }, eases });
  assert.equal(runs, 1);
  assert.deepEqual(r.runs.map((x) => x.route), ['one']);
  assert.equal(overnightJobs().find((j) => j.id === 'suite').last.failed, '');
});

test('with Nightly full suite off in Overnight work, nothing runs', async () => {
  fs.rmSync(suiteStateFile(), { force: true });
  const sites = Object.fromEntries([board('gamma')]);
  await setOvernight('suite', false);
  let runs = 0;
  assert.equal(await runNightlySuite({ now: t(3), settings: DEFAULTS, manifest: { sites }, runTests: async () => { runs++; return passing; }, eases }), null);
  assert.equal(runs, 0);
  assert.equal(overnightJobs().find((j) => j.id === 'suite').on, false);
  await setOvernight('suite', true);
});

// docs/adr/2026-11-21-2310-a-land-runs-its-repos-own-test-script.md
test("each board's repo runs its own test script, handed no base so it runs whole; a failing one files its exit and last lines, and a repo with no tests at all can't run", async () => {
  fs.rmSync(suiteStateFile(), { force: true });
  const scripted = makeRepo('scripted');
  fs.mkdirSync(path.join(scripted, '.kickflip'));
  fs.writeFileSync(path.join(scripted, '.kickflip', 'test'), '#!/bin/sh\necho "args: $#"\necho "FAIL: login" >&2\nexit 3\n', { mode: 0o755 });
  git(scripted, 'add', '.kickflip');
  git(scripted, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'test script');
  const sites = Object.fromEntries([board('scripted', scripted), board('bare')]);
  const r = await runNightlySuite({ now: t(3), settings: DEFAULTS, manifest: { sites }, eases });
  assert.deepEqual(r.runs.map((x) => [x.route, x.ok]), [['scripted', false], ['bare', false]]);
  const [filed] = asks(sites.scripted.dir);
  assert.match(filed.data.text, /^Nightly full suite failed on main at [0-9a-f]{7,}: \.kickflip\/test exited 3\.\n/);
  assert.match(filed.data.text, /- args: 0\n- FAIL: login\n/);
  assert.equal(r.runs[1].error, 'no test command for bare: add an executable .kickflip/test, handed the base; one that exits 0 lands untested');
});
