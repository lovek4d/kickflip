// #362: what a block does to a card past Todo
// (docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md). A block pausing a running build is
// card-pause.test.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boardWith, home, at, site, write, read, lines, run, wave, commit, git, scratchRepo, worktree, boardWorktree, itemOf, threadOf, record } from './board-fixture.mjs';
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
  commit(boardWorktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
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

// docs/adr/2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md,
// docs/adr/2026-11-24-0100-a-block-holds-every-transition-and-its-end-moves-the-card-or-opens-a-wait.md
test("a landed dep ends a staged card's block, owed from the unblock, its Implement tap kept, and it can go ready", async (t) => {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = oldHome; });
  write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', phase: 'staging', staged_at: '2026-11-16T10:00:00.000Z', size: 'small', plan: 'a1-notes.md', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  write(site('orch', 'data', 'events.jsonl'), '');
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), `${JSON.stringify({ id: 'b1', ts: now(), kind: 'card-bump', data: { key: 'w/A1' }, reply: null })}\n`);
  await store.setItem(site('orch'), 'w/ENG-1', { done: true, closing: ['handed-closed', {}], landed: 'abc1234' });
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));
  const unblocked = threadOf().find((l) => l.line === 'unblocked-done');
  assert.deepEqual([itemOf().phase, itemOf().staged_at, itemOf().unblocked_at], ['staging', '2026-11-16T10:00:00.000Z', unblocked.ts]);
  assert.equal(events().some((e) => e.kind === 'card-unbump'), false, 'its Implement tap stays');
  const judged = await onOrch('item', 'set', 'w/A1', '--phase', 'ready', '--text', 'Re-judged against ENG-1: nothing stale.');
  assert.equal(judged.code, 0, judged.err);
  assert.equal(itemOf().phase, 'ready');
});

test("the staging re-judge answers a stale question again with question settle, only on a staged card", async () => {
  write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'feat: one', phase: 'staging', staged_at: now(), size: 'small', plan: 'a1-notes.md' }, { id: 'ENG-1', title: 'Later', lane: 'done' }] });
  const asked = { id: 'q1', topic: 'item:w/A1', question: 'Which API?', asked_at: '2026-11-08T10:00:00Z', resolved: "Recorded in the task's notes", resolved_at: '2026-11-08T11:00:00Z' };
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [asked, { ...asked, id: 'q2', topic: 'item:w/ENG-1' }] });
  const settled = await onOrch('question', 'settle', 'q1', '--answered-by', 'ENG-1', '--note', 'ENG-1 landed the v2 API: use it.');
  assert.equal(settled.code, 0, settled.err);
  const q = read(site('orch', 'data', 'owner.json')).items.find((x) => x.id === 'q1');
  assert.equal(q.resolved, 'Settled by the orchestrator, answered in ENG-1: ENG-1 landed the v2 API: use it.');
  assert.match(fs.readFileSync(at('waves', 'w', 'a1-notes.md'), 'utf8'), /- q1 \(Which API\?\): settled by the orchestrator, answered in ENG-1\. "ENG-1 landed the v2 API: use it\."/);
  const other = await onOrch('question', 'settle', 'q2', '--answered-by', 'ENG-1', '--note', 'x');
  assert.equal(other.code, 1);
  assert.match(other.err, /w\/ENG-1 isn't staged/);
});

test('an unblock outside ready leaves the phase, and records when the block ended', async () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two', phase: 'grilling', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  assert.equal((await onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.')).code, 0);
  assert.equal(itemOf('A2').phase, 'grilling', 'its grill goes on; staging judges it after');
  assert.ok(itemOf('A2').unblocked_at);
});

test('--next naming an unfinished card by its #number is refused without --deps', async () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'review' }, { id: 'ENG-1', title: 'Later', ticket: '#398', lane: 'progress' }] });
  const r = await onOrch('item', 'set', 'w/A1', '--next', 'Tag once #398 lands');
  assert.equal(r.code, 1);
  assert.match(r.err, /names unfinished task w\/ENG-1; add it with --blocked-by/);
  assert.equal((await onOrch('item', 'set', 'w/A1', '--blocked-by', 'ENG-1', '--next', 'Tag once #398 lands')).code, 0);
});
