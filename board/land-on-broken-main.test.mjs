import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, commit, scratchRepo, boardWorktree as worktree, onOrch, record, itemOf, threadOf, at, read, write, onHome, site } from './board-fixture.mjs';
import { landable } from './store.mjs';
import { builtCards } from './snapshot.mjs';

// docs/adr/2026-11-17-0519-a-land-failing-on-mains-own-test-blocks-on-mains-fix.md
// Main fails scan.test.mjs, which reads shared/list.mjs: a change to that file touches the test.
const SCAN = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { bad } from './shared/list.mjs';\ntest('scan', () => { assert.deepEqual(bad, [], 'list nothing bad'); });\n";
function brokenMain() {
  const repo = scratchRepo();
  write(`${repo}/shared/list.mjs`, "export const bad = ['old'];\n");
  commit(repo, 'scan.test.mjs', SCAN, 'test: scan');
  return repo;
}
async function built(repo, list) {
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'shared/list.mjs', list, 'feat: work\n\nRefs: A1');
}

test("a land whose touched test fails on main the same way lands, leaving a Found: call", async () => {
  const repo = brokenMain();
  await built(repo, "// The bad names.\nexport const bad = ['old'];\n");
  const main = git(repo, 'rev-parse', 'main');
  const r = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().lane, 'done');
  assert.ok(record().calls.some((c) => /^Found: scan\.test\.mjs fails on main too/.test(c.text)), JSON.stringify(record().calls));
});

test("a land whose test fails on main too, but differently, files main's fix and blocks on it, keeping the build verified for its lander", async (t) => {
  onHome(t);
  const repo = brokenMain();
  await built(repo, "export const bad = ['old', 'new'];\n");
  const main = git(repo, 'rev-parse', 'main');
  const r = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(repo, 'rev-parse', 'main'), main, 'nothing landed');
  const items = read(at('waves', 'w', 'wave.json')).items;
  const fix = items.find((i) => !['A1', 'ENG-1'].includes(i.id));
  assert.ok(fix, 'a card for main\'s fix was filed');
  assert.match(fix.title, /scan\.test\.mjs/);
  assert.deepEqual(itemOf().deps, [fix.id]);
  assert.match(r.out, new RegExp(`blocked by .*${fix.id}|blocked by #`));
  assert.ok(threadOf().some((m) => m.line === 'land-held-on-base'), 'the thread says why it waits');
  assert.ok(record().handed_back && record().verified?.at, 'handed back, still verified');
  assert.equal(record().calls?.length ?? 0, 0, 'no call to verify again');
  // What blocks it is the built card's, which its land step reads (domain.mjs landSkipOf).
  assert.deepEqual((await landable(site('orch'))).map((l) => [l.key, l.skip?.step]), [['w/A1', undefined]]);
  assert.equal((await builtCards(site('orch'))).get('w/A1').land?.step, 'blocked');
});

test("a land whose test fails on main too blocks on an open card whose title names the test, filing none", async () => {
  const repo = brokenMain();
  const wave = read(at('waves', 'w', 'wave.json'));
  wave.items.find((i) => i.id === 'ENG-1').title = 'fix: scan.test lists nothing bad on main again';
  write(at('waves', 'w', 'wave.json'), wave);
  await built(repo, "export const bad = ['old', 'new'];\n");
  const r = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.length, 2, 'nothing filed');
  assert.deepEqual(itemOf().deps, ['ENG-1']);
});
