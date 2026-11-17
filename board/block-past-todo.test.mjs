// #362: what a block does to a card past Todo
// (docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md). A block pausing a running build is
// card-pause.test.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boardWith, home, at, site, write, read, lines, run, wave, commit, git, scratchRepo, worktree, itemOf, threadOf, record } from './board-fixture.mjs';
import { fakeGh, prView, writePR, calls } from '../shared/fake-gh.mjs';
import * as store from './store.mjs';
import { builtCards } from './snapshot.mjs';

const now = () => new Date().toISOString();
const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const events = () => lines(site('orch', 'data', 'events.jsonl'));
const onOrch = (...args) => boardWith(['--site', 'orch', ...args]);

test('blocking a handed-back card, with nothing running, leaves it In Progress with its hand-back', async () => {
  setA1({ lane: 'progress', phase: 'ready' });
  write(recordFile(), { started: new Date(Date.now() - 60_000).toISOString(), done: now(), handed_back: now(), kind: 'claude' });
  const r = await onOrch('item', 'set', 'w/A1', '--blocked-until', 'the API ships');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([itemOf().lane, itemOf().blocked_until], ['progress', 'the API ships']);
  assert.deepEqual(threadOf().map((l) => l.text), ['Blocked until the API ships: it stays In Progress.']);
  assert.ok(record().handed_back, 'its hand-back stays');
});

test('a blocked card In Review stays there, and merge refuses it naming what blocks it, before asking GitHub', async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  write(waveFile(), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, phase: 'ready', lane: 'review' }, { id: 'ENG-1', title: 'Later' }] });
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  assert.equal((await onOrch('item', 'set', 'w/A1', '--blocked-by', 'ENG-1')).code, 0);
  assert.deepEqual([itemOf().pr, fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl'))], [7, false], 'In Review, nothing is sent back');
  const merge = await boardWith(['--site', 'orch', 'merge', 'w/A1'], env);
  assert.deepEqual([merge.code, merge.err], [1, 'Not merged: blocked by ENG-1.\n']);
  assert.deepEqual(calls(dir), []);
  assert.equal(itemOf().lane, 'review');
});

test('land refuses a blocked card with Auto-merge on, leaving main as it was', async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  setA1({ deps: ['ENG-1'] });
  const main = git(repo, 'rev-parse', 'main');
  const landed = await onOrch('land', 'w/A1', '--text', 'Checked.');
  assert.equal(landed.code, 1);
  assert.match(landed.err, /A1 is blocked by ENG-1, so it can't land; it lands once nothing blocks it\n$/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);

});

test("a blocked card's held Merge can't be tapped, and the lander skips its verified build", async (t) => {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = oldHome; });
  setA1({ deps: ['ENG-1'], merge_ready: { branch: 'A1', at: now() } });
  await assert.rejects(store.tapMerge(site('orch'), 'w/A1'), { message: 'w/A1 is blocked by ENG-1, so its Merge waits until nothing blocks it' });
  assert.equal(itemOf().merge_ready.tapped, undefined);

  const tree = path.join(home, 'tree');
  fs.mkdirSync(tree, { recursive: true });
  setA1({ merge_ready: undefined, lane: 'progress' });
  write(recordFile(), { started: now(), done: now(), handed_back: now(), kind: 'claude', worktree: { path: tree }, verified: { at: now() } });
  // What blocks it is the built card's (domain.mjs landSkipOf), which its land step reads.
  const landOf = async () => { const { land } = (await builtCards(site('orch'))).get('w/A1'); return land && { step: land.step, blocked: land.blocked }; };
  assert.deepEqual((await store.landable(site('orch'))).map((c) => [c.key, c.skip]), [['w/A1', null]]);
  assert.deepEqual(await landOf(), { step: 'blocked', blocked: 'by ENG-1' });
  setA1({ deps: undefined });
  assert.deepEqual(await landOf(), { step: 'launch', blocked: undefined });
  // A gone worktree is the skip a block can't hide: it needs the orchestrator.
  setA1({ deps: ['ENG-1'] });
  fs.rmSync(tree, { recursive: true });
  assert.deepEqual((await store.landable(site('orch'))).map((c) => [c.key, c.skip]), [['w/A1', { step: 'worktree-gone' }]]);
  assert.deepEqual(await landOf(), { step: 'worktree-gone', blocked: undefined });
});

test('a finishing dep unblocks a card In Review, waking the orchestrator', async () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, lane: 'review', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  const r = await onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /unblocked: w\/A1/);
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));
  assert.ok(itemOf().unblocked_at, 'it records when the block ended, which makes the orchestrator wait');
});

test('a finishing dep records unblocked_at on a staging card, which reopens its staging wait unpicked', async () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', phase: 'staging', staged_at: '2026-11-16T10:00:00.000Z', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  assert.equal((await onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.')).code, 0);
  assert.ok(itemOf().unblocked_at);
});

// docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md
test('a finishing dep makes a ready Todo card wait on the orchestrator to re-check its notes, and --phase ready --text releases it', async () => {
  write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', phase: 'ready', size: 'small', plan: 'a1-notes.md', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  assert.equal((await onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.')).code, 0);
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));
  assert.ok(itemOf().recheck_at, 'it waits for the re-check');
  assert.equal(itemOf().unblocked_at, undefined, 'a Todo task has no past-Todo wait');
  const bare = await onOrch('item', 'set', 'w/A1', '--phase', 'ready');
  assert.equal(bare.code, 1);
  assert.match(bare.err, /pass --text "<what you re-checked/);
  const released = await onOrch('item', 'set', 'w/A1', '--phase', 'ready', '--text', 'Re-checked against ENG-1: nothing stale.');
  assert.equal(released.code, 0, released.err);
  assert.deepEqual([itemOf().phase, itemOf().recheck_at], ['ready', undefined]);
  assert.match(fs.readFileSync(at('waves', 'w', 'a1-notes.md'), 'utf8'), /## Re-checked \(orchestrator, [^)]+\)\n+Re-checked against ENG-1: nothing stale\./);
});

test("the re-check answers a stale question again with question settle, only on a card waiting on it", async () => {
  write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', phase: 'ready', size: 'small', plan: 'a1-notes.md', recheck_at: now() }, { id: 'ENG-1', title: 'Later', lane: 'done' }] });
  const asked = { id: 'q1', topic: 'item:w/A1', question: 'Which API?', asked_at: '2026-11-08T10:00:00Z', resolved: "Recorded in the task's notes", resolved_at: '2026-11-08T11:00:00Z' };
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [asked, { ...asked, id: 'q2', topic: 'item:w/ENG-1' }] });
  const settled = await onOrch('question', 'settle', 'q1', '--note', 'ENG-1 landed the v2 API: use it.');
  assert.equal(settled.code, 0, settled.err);
  const q = read(site('orch', 'data', 'owner.json')).items.find((x) => x.id === 'q1');
  assert.equal(q.resolved, 'Settled by the orchestrator: ENG-1 landed the v2 API: use it.');
  assert.match(fs.readFileSync(at('waves', 'w', 'a1-notes.md'), 'utf8'), /- q1 \(Which API\?\): settled by the orchestrator\. "ENG-1 landed the v2 API: use it\."/);
  const other = await onOrch('question', 'settle', 'q2', '--note', 'x');
  assert.equal(other.code, 1);
  assert.match(other.err, /w\/ENG-1 waits on no re-check/);
});

test('a re-check that sends the card back to grilling ends the wait, and an unblock outside ready marks none', async () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', phase: 'ready', recheck_at: now() }, { id: 'A2', title: 'Two', phase: 'grilling', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  assert.equal((await onOrch('item', 'set', 'w/A1', '--phase', 'grilling')).code, 0);
  assert.deepEqual([itemOf().phase, itemOf().recheck_at], ['grilling', undefined]);
  assert.equal((await onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.')).code, 0);
  assert.equal(itemOf('A2').recheck_at, undefined, 'its grill goes on; staging judges it after');
});

test("a build started on a card waiting on its re-check, as the owner's Implement tap starts one, ends the wait", async () => {
  setA1({ phase: 'ready', recheck_at: now() });
  const started = await onOrch('builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.deepEqual([itemOf().lane, itemOf().recheck_at], ['progress', undefined]);
});

test('--next naming an unfinished card by its #number is refused without --deps', async () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'review' }, { id: 'ENG-1', title: 'Later', ticket: '#398', lane: 'progress' }] });
  const r = await onOrch('item', 'set', 'w/A1', '--next', 'Tag once #398 lands');
  assert.equal(r.code, 1);
  assert.match(r.err, /names unfinished task w\/ENG-1; add it with --blocked-by/);
  assert.equal((await onOrch('item', 'set', 'w/A1', '--blocked-by', 'ENG-1', '--next', 'Tag once #398 lands')).code, 0);
});

// docs/adr/2026-11-17-0700-a-recheck-whose-blocker-touched-none-of-the-tasks-files-releases-itself.md
const recheckCase = async (notes, files) => {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  if (notes !== null) write(at('waves', 'w', 'a1-notes.md'), notes);
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', phase: 'ready', size: 'small', ...(notes === null ? {} : { plan: 'a1-notes.md' }), deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  await store.setItem(site('orch'), 'w/ENG-1', { done: true, closing: ['handed-closed', {}], landed: 'abc1234', landedFiles: files }).finally(() => { process.env.HOME = oldHome; });
};

test("a blocker that landed none of the task's noted files releases its recheck with a thread line", async () => {
  await recheckCase('Change board/server.mjs and docs/adr.\n', ['hub/push.mjs', 'README.md']);
  assert.equal(itemOf().recheck_at, undefined);
  assert.equal(itemOf().phase, 'ready');
  assert.equal(threadOf().at(-1).text, "Recheck: ENG-1 touched none of this task's files");
});

test("a blocker that landed a noted file, or inside a noted folder, still waits on the recheck", async () => {
  await recheckCase('Change board/server.mjs.\n', ['board/server.mjs']);
  assert.ok(itemOf().recheck_at);
  await recheckCase('Write docs/adr.\n', ['docs/adr/x.md']);
  assert.ok(itemOf().recheck_at);
  await recheckCase('Edit SKILL.md.\n', ['SKILL.md']);
  assert.ok(itemOf().recheck_at);
});

test('notes naming no files keep the recheck wait, and so does a blocker with no recorded diff', async () => {
  await recheckCase('Make it nicer, e.g. faster.\n', ['hub/push.mjs']);
  assert.ok(itemOf().recheck_at);
  await recheckCase('Change board/server.mjs.\n', undefined);
  assert.ok(itemOf().recheck_at);
});
