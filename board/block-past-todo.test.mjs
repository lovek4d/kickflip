// #362: what a block does to a card past Todo
// (docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md). A block pausing a running build is
// card-pause.test.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, at, site, write, read, lines, run, wave, commit, git, scratchRepo, worktree, itemOf, threadOf, record } from './board-fixture.mjs';
import { fakeGh, prView, writePR, calls } from '../shared/fake-gh.mjs';
import * as store from './store.mjs';

const now = () => new Date().toISOString();
const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const events = () => lines(site('orch', 'data', 'events.jsonl'));
const onOrch = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });

test('blocking a handed-back card, with nothing running, leaves it In Progress with its hand-back', () => {
  setA1({ lane: 'progress', phase: 'ready' });
  write(recordFile(), { started: new Date(Date.now() - 60_000).toISOString(), done: now(), handed_back: now(), kind: 'claude' });
  const r = onOrch('item', 'set', 'w/A1', '--blocked-until', 'the API ships');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([itemOf().lane, itemOf().blocked_until], ['progress', 'the API ships']);
  assert.deepEqual(threadOf().map((l) => l.text), ['Blocked until the API ships: it stays In Progress.']);
  assert.ok(record().handed_back, 'its hand-back stays');
});

test('a blocked card In Review stays there, and merge refuses it naming what blocks it, before asking GitHub', () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  write(waveFile(), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, phase: 'ready', lane: 'review' }, { id: 'ENG-1', title: 'Later' }] });
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  assert.equal(onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1').code, 0);
  assert.deepEqual([itemOf().pr, fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl'))], [7, false], 'In Review, nothing is sent back');
  const merge = run('board.mjs', ['--site', 'orch', 'merge', 'w/A1'], undefined, env);
  assert.deepEqual([merge.code, merge.err], [1, 'Not merged: blocked by ENG-1.\n']);
  assert.deepEqual(calls(dir), []);
  assert.equal(itemOf().lane, 'review');
});

test('land refuses a blocked card with Auto-merge on, leaving main as it was', () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  setA1({ deps: ['ENG-1'] });
  const main = git(repo, 'rev-parse', 'main');
  const landed = onOrch('land', 'w/A1', '--text', 'Checked.');
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
  assert.deepEqual(await store.landable(site('orch')), []);
  setA1({ deps: undefined });
  assert.deepEqual((await store.landable(site('orch'))).map((c) => c.key), ['w/A1']);
});

test('a finishing dep unblocks a card In Review, waking the orchestrator', () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, lane: 'review', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  const r = onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /unblocked: w\/A1/);
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));
  assert.ok(itemOf().unblocked_at, 'it records when the block ended, which makes the orchestrator wait');
});

// docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md
test('a finishing dep makes a ready Todo card wait on the orchestrator to re-check its notes, and --phase ready --text releases it', () => {
  write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', phase: 'ready', size: 'small', plan: 'a1-notes.md', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  assert.equal(onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.').code, 0);
  assert.ok(events().some((e) => e.kind === 'card-unblocked' && e.data.key === 'w/A1'));
  assert.ok(itemOf().recheck_at, 'it waits for the re-check');
  assert.equal(itemOf().unblocked_at, undefined, 'a Todo card has no past-Todo wait');
  const bare = onOrch('item', 'set', 'w/A1', '--phase', 'ready');
  assert.equal(bare.code, 1);
  assert.match(bare.err, /pass --text "<what you re-checked/);
  const released = onOrch('item', 'set', 'w/A1', '--phase', 'ready', '--text', 'Re-checked against ENG-1: nothing stale.');
  assert.equal(released.code, 0, released.err);
  assert.deepEqual([itemOf().phase, itemOf().recheck_at], ['ready', undefined]);
  assert.match(fs.readFileSync(at('waves', 'w', 'a1-notes.md'), 'utf8'), /## Re-checked \(orchestrator, [^)]+\)\n+Re-checked against ENG-1: nothing stale\./);
});

test("the re-check answers a stale question again with question settle, only on a card waiting on it", () => {
  write(at('waves', 'w', 'a1-notes.md'), 'Build it.\n');
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', phase: 'ready', size: 'small', plan: 'a1-notes.md', recheck_at: now() }, { id: 'ENG-1', title: 'Later', lane: 'done' }] });
  const asked = { id: 'q1', topic: 'item:w/A1', question: 'Which API?', asked_at: '2026-11-08T10:00:00Z', resolved: "Recorded in the card's notes", resolved_at: '2026-11-08T11:00:00Z' };
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [asked, { ...asked, id: 'q2', topic: 'item:w/ENG-1' }] });
  const settled = onOrch('question', 'settle', 'q1', '--note', 'ENG-1 landed the v2 API: use it.');
  assert.equal(settled.code, 0, settled.err);
  const q = read(site('orch', 'data', 'owner.json')).items.find((x) => x.id === 'q1');
  assert.equal(q.resolved, 'Settled by the orchestrator: ENG-1 landed the v2 API: use it.');
  assert.match(fs.readFileSync(at('waves', 'w', 'a1-notes.md'), 'utf8'), /- q1 \(Which API\?\): settled by the orchestrator\. "ENG-1 landed the v2 API: use it\."/);
  const other = onOrch('question', 'settle', 'q2', '--note', 'x');
  assert.equal(other.code, 1);
  assert.match(other.err, /w\/ENG-1 waits on no re-check/);
});

test('a re-check that sends the card back to grilling ends the wait, and an unblock outside ready marks none', () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', phase: 'ready', recheck_at: now() }, { id: 'A2', title: 'Two', phase: 'grilling', deps: ['ENG-1'] }, { id: 'ENG-1', title: 'Later', lane: 'progress' }] });
  assert.equal(onOrch('item', 'set', 'w/A1', '--phase', 'grilling').code, 0);
  assert.deepEqual([itemOf().phase, itemOf().recheck_at], ['grilling', undefined]);
  assert.equal(onOrch('item', 'set', 'w/ENG-1', '--done', '--text', 'Done.').code, 0);
  assert.equal(itemOf('A2').recheck_at, undefined, 'its grill goes on; staging judges it after');
});

test("a build started on a card waiting on its re-check, as the owner's Implement tap starts one, ends the wait", () => {
  setA1({ phase: 'ready', recheck_at: now() });
  const started = onOrch('builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.deepEqual([itemOf().lane, itemOf().recheck_at], ['progress', undefined]);
});

test('--next naming an unfinished card by its #number is refused without --deps', () => {
  write(waveFile(), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'review' }, { id: 'ENG-1', title: 'Later', ticket: '#398', lane: 'progress' }] });
  const r = onOrch('item', 'set', 'w/A1', '--next', 'Tag once #398 lands');
  assert.equal(r.code, 1);
  assert.match(r.err, /names unfinished card w\/ENG-1; add it with --deps/);
  assert.equal(onOrch('item', 'set', 'w/A1', '--deps', 'ENG-1', '--next', 'Tag once #398 lands').code, 0);
});
