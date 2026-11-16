import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeTests } from './worktree.mjs';
import * as store from './store.mjs';
import { home, at, site, board, lines } from './board-fixture.mjs';

// docs/adr/2026-11-13-2030-a-test-run-reports-live-lines-the-thread-does-not-show.md
// Two quick test files and one that blocks reading a named pipe until the report's update opens it for writing, so the
// run is still going when the first update is reported, however loaded the host is.
function suite() {
  const dir = fs.mkdtempSync(path.join(home, 'suite-'));
  const pipe = path.join(dir, 'release');
  spawnSync('mkfifo', [pipe]);
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(dir, `${name}.test.mjs`), "import test from 'node:test';\ntest('t', () => {});\n");
  fs.writeFileSync(path.join(dir, 'held.test.mjs'), `import test from 'node:test';\nimport fs from 'node:fs';\ntest('t', () => { fs.readFileSync(${JSON.stringify(pipe)}); });\n`);
  return { dir, release: () => fs.writeFileSync(pipe, 'go') };
}

test('a run reports its start, updates while it runs, and its result in words', async () => {
  const { dir, release } = suite();
  const said = [];
  let released = 0;
  const report = {
    start: (w) => said.push(['start', w]),
    update: (w) => { said.push(['update', w]); if (/^[1-9]/.test(w) && !released++) release(); },
    end: (w) => said.push(['end', w]),
  };
  const r = await nodeTests(dir, { report, every: 20 });
  assert.equal(r.ok, true);
  assert.deepEqual(said[0], ['start', 'full suite, 3 test files']);
  assert.ok(said.some(([kind, w]) => kind === 'update' && /^[1-9]\d* tests run, 0 failing$/.test(w)), JSON.stringify(said));
  assert.match(said.at(-1)[1], /^3 passed, 0 failed in \d+m \d+s$/);
  assert.equal(said.at(-1)[0], 'end');
  const chosen = await nodeTests(dir, { files: ['a.test.mjs'], report });
  assert.equal(chosen.ok, true);
  assert.equal(said.find((s, i) => i > 3 && s[0] === 'start')[1], '1 test files');
});

test("a card's test report writes live lines that replace each other: only the start and result reach the thread, and the build never reads stale", async () => {
  assert.equal((await board('builder', 'start', 'audit/A1', '--site', 'audit', '--kind', 'claude')).code, 0);
  const report = await store.testReport(site('audit'), 'audit/A1', { phase: 'building' });
  await report.start('full suite, 3 test files');
  await report.update('1 tests run, 0 failing');
  await report.update('2 tests run, 0 failing');
  await report.end('3 passed, 0 failed in 0m 9s');
  const thread = lines(site('audit', 'data', 'threads', 'audit__A1.jsonl')).filter((m) => m.kind === 'status');
  assert.deepEqual(thread.map((m) => [m.text, Boolean(m.live), m.phase]), [
    ['Building: full suite, 3 test files', false, 'building'],
    ['Building: 1 tests run, 0 failing', true, 'building'],
    ['Building: 2 tests run, 0 failing', true, 'building'],
    ['Building: 3 passed, 0 failed in 0m 9s', false, 'building'],
  ]);
  const landing = await store.testReport(site('audit'), 'audit/A1', { phase: 'landing' });
  await landing.start('12 test files');
  assert.equal(lines(site('audit', 'data', 'threads', 'audit__A1.jsonl')).at(-1).text, 'Landing: 12 test files');
});

test('a test report on a worktree finds the card whose open build keeps it', async () => {
  assert.equal((await board('builder', 'start', 'audit/A1', '--site', 'audit', '--kind', 'claude')).code, 0);
  const rec = JSON.parse(fs.readFileSync(site('audit', 'data', 'agents', 'A1.json'), 'utf8'));
  rec.worktree = { path: '/tmp/some-worktree' };
  fs.writeFileSync(site('audit', 'data', 'agents', 'A1.json'), JSON.stringify(rec));
  assert.equal(await store.cardOfWorktree(site('audit'), '/tmp/some-worktree'), 'audit/A1');
  assert.equal(await store.cardOfWorktree(site('audit'), '/tmp/elsewhere'), null);
});

// After a failed land the card's main record is the lander's and the builder's run sits in a past record: every status
// line the land writes still carries the run its section folds under, and a line that would carry none is refused.
test("a land's status lines keep the card's run once a lander holds the main record", async () => {
  const file = site('audit', 'data', 'agents', 'A1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lander = { kind: 'claude', label: 'Lander', started: '2026-11-16T06:09:04.924Z', session: { id: 's1' } };
  fs.writeFileSync(file, JSON.stringify(lander));
  await store.landingLine(site('audit'), 'audit/A1');
  const report = await store.testReport(site('audit'), 'audit/A1', { phase: 'landing' });
  await report.start('151 test files');
  await report.end('2080 passed, 0 failed in 1m 2s');
  const thread = lines(site('audit', 'data', 'threads', 'audit__A1.jsonl')).filter((m) => m.kind === 'status');
  assert.deepEqual(thread.map((m) => m.run), Array(3).fill(lander.started));
});

test('a status line with no run to keep is an error while a run is open', async () => {
  const file = site('audit', 'data', 'agents', 'A1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ kind: 'grill', started: '2026-11-16T06:09:04.924Z', session: { id: 's1' } }));
  await assert.rejects(store.landingLine(site('audit'), 'audit/A1'), /open run but no build/);
  await assert.rejects(store.testReport(site('audit'), 'audit/A1', { phase: 'landing' }), /open run but no build/);
});
