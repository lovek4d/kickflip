import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { land as landWorktree } from './worktree.mjs';
import { fakeGh, prView, writePR, writeReviews, writeMerge, writeLimit, calls } from '../shared/fake-gh.mjs';
import { clock } from '../hub/schedule.mjs';
import { boardWith, bin, home, at, site, write, read, lines, run, board, wave, question, git, commit, scratchRepo, worktree, restarts, land, branches, finishEnv, onOrch, record, itemOf, threadOf, addEvents } from './board-fixture.mjs';

test("merge squashes a card's PR once GitHub would merge it, with no commit after the approval unexplained and manual steps on the owner's word, and leaves its refusal off the card's thread", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => boardWith(['--site', 'orch', 'merge', ...args], env);
  const thread = () => (fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')) ? lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text) : []);
  const merges = () => calls(dir).filter((a) => a[1] === 'merge');
  const approved = (commit) => writeReviews(dir, 7, [{ id: 1, user: { login: 'ann' }, state: 'APPROVED', submitted_at: '2026-11-01T10:00:00Z', commit_id: commit }]);
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, lane: 'progress', manual_steps: ['Run the backfill'] }, { id: 'A2', title: 'Two', pr: 8 }, { id: 'A3', title: 'Three' }] });
  writePR(dir, 7, prView({ failing: ['build'], pending: 1 }));
  assert.deepEqual(await merge('w/A1'), { code: 1, out: '', err: "Not merged: review: review required; failing: build; merge state: blocked; manual steps: merge only on the owner's word, with --confirmed \"<their words>\".\n" });
  assert.deepEqual(thread(), []);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), [
    { id: 'e3', ts: '2026-11-01T11:01:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'The backfill ran on prod.' } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', head: 'bbb' }));
  approved('aaa');
  const after = await merge('w/A1', '--confirmed', 'the backfill ran on prod');
  assert.equal(after.code, 1);
  assert.match(after.err, /^Not merged: commits after the approval: pass --after-approval/);
  assert.deepEqual(thread(), []);
  assert.match((await merge('w/A1', '--after-approval', 'Rebased.', '--confirmed', 'the backfill is done')).err, /--confirmed must quote the owner's words/);
  approved('bbb');
  assert.match((await merge('w/A1', '--after-approval', 'Rebased.', '--confirmed', 'the backfill ran on prod')).err, /--after-approval: no commit came after the approval/);
  writePR(dir, 8, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  assert.match((await merge('w/A2', '--confirmed', 'the backfill ran on prod')).err, /--confirmed: w\/A2 has no manual steps/);
  assert.match((await merge('w/A3')).err, /w\/A3 has no PR/);
  writeMerge(dir, 8, { error: 'Pull request is not mergeable: the base branch policy prohibits the merge.' });
  assert.deepEqual(await merge('w/A2'), { code: 1, out: '', err: 'gh pr merge #8 failed: Pull request is not mergeable: the base branch policy prohibits the merge.\n' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[1].lane, undefined);
  assert.equal(merges().length, 1);
  approved('aaa');
  const done = await merge('w/A1', '--after-approval', 'Only a rebase onto main.', '--confirmed', 'the backfill ran on prod');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out.trim().split('\n').at(-1), 'A1: merged');
  assert.deepEqual(merges().at(-1), ['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--subject', 'feat: the work', '--body', 'Checked it.\n\nRefs: A1\nCo-Authored-By: Claude <noreply@anthropic.com>']);
  const merged = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([merged.lane, merged.prs.map((p) => [p.number, typeof p.merged_at])], ['done', [[7, 'string']]]);
  // The board's merged line, then the orchestrator's words on the merge as its message.
  assert.deepEqual(thread().slice(-2), ['Merged PR #7.', 'After the approval: Only a rebase onto main. The owner\'s word on the manual steps: "the backfill ran on prod"']);
  writePR(dir, 8, prView({ state: 'MERGED' }));
  assert.equal((await merge('w/A2')).code, 0);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A2.jsonl')).at(-1).text, 'PR #8 was already merged.');
  assert.equal(merges().length, 2);
});

// docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md
test("while GitHub's limit holds, merge refuses at once with the reset time and says so in the card's thread", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => boardWith(['--site', 'orch', 'merge', ...args], env);
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, lane: 'review' }] });
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  const reset = new Date(Math.floor(Date.now() / 1000 + 3600) * 1000);
  writeLimit(dir, { graphql: reset.toISOString() });
  const words = `GitHub rate limited, resets at ${clock(reset)}`;
  assert.deepEqual(await merge('w/A1'), { code: 1, out: '', err: `o/r#7: ${words}\n` });
  const ran = calls(dir).length;
  assert.deepEqual(await merge('w/A1'), { code: 1, out: '', err: `o/r#7: ${words}\n` });
  assert.equal(calls(dir).length, ran, 'a merge under the limit runs no gh');
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => [m.line, m.text]), [['gh-limited', `Not merged: ${words}.`], ['gh-limited', `Not merged: ${words}.`]]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'review');
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("merge counts commits after the approval as trivial when the board's rebase runs pushed them, and says so", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => boardWith(['--site', 'orch', 'merge', ...args], env);
  const rebased = (...steps) => write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7,
    rebased: steps.map(([from, to, replayed = true]) => ({ from, to, base: 'main', replayed, at: '2026-11-05T10:00:00Z' })) }] });
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', head: 'ccc' }));
  writeReviews(dir, 7, [{ id: 1, user: { login: 'ann' }, state: 'APPROVED', submitted_at: '2026-11-01T10:00:00Z', commit_id: 'aaa' }]);
  rebased(['zzz', 'ccc']);
  assert.match((await merge('w/A1')).err, /^Not merged: commits after the approval/, "a run that didn't start from the approved commit isn't the only change");
  rebased(['aaa', 'bbb'], ['bbb', 'ccc', false]);
  assert.match((await merge('w/A1')).err, /^Not merged: commits after the approval/, 'a run that added commits of its own made no rebase-only push');
  rebased(['aaa', 'bbb'], ['bbb', 'ccc']);
  const done = await merge('w/A1');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).slice(-2).map((m) => [m.kind ?? null, m.text]), [['hub', 'Merged PR #7.'], [null, "After the approval: only the board's rebase onto main."]]);
});

test("merge takes every PR on a card across repos in its order, refusing while any open one isn't ready and leaving a merged or closed one be", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => boardWith(['--site', 'orch', 'merge', ...args], env);
  const merges = () => calls(dir).filter((a) => a[1] === 'merge').map((a) => `${a[4]}#${a[2]}`);
  const thread = (id) => lines(site('orch', 'data', 'threads', `w__${id}.jsonl`)).map((m) => m.text);
  const ready = prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' });
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [
    { id: 'A1', title: 'Two repos', prs: [{ number: 6 }, { repo: 'o/site', number: 1 }] },
    { id: 'A2', title: 'One left', prs: [{ repo: 'o/site', number: 2 }, { number: 9 }, { number: 10 }] },
    { id: 'A3', title: 'All in', prs: [{ number: 11 }, { repo: 'o/site', number: 3 }] },
  ] });
  writePR(dir, 'o/r#6', ready);
  writePR(dir, 'o/site#1', prView({ isDraft: true, failing: ['build'] }));
  const refused = await merge('w/A1');
  assert.equal(refused.code, 1);
  assert.equal(refused.err, 'Not merged: o/site#1 it is a draft; o/site#1 review: review required; o/site#1 failing: build; o/site#1 merge state: blocked.\n');
  assert.deepEqual(merges(), []);
  writePR(dir, 'o/site#1', ready);
  const done = await merge('w/A1');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(merges(), ['o/r#6', 'o/site#1']);
  const merged = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([merged.lane, merged.prs.map((p) => typeof p.merged_at)], ['done', ['string', 'string']]);
  assert.equal(thread('A1').at(-1), 'Merged PRs #6, o/site#1.');
  writePR(dir, 'o/site#2', prView({ state: 'MERGED' }));
  writePR(dir, 'o/r#9', prView({ state: 'CLOSED' }));
  writePR(dir, 'o/r#10', ready);
  assert.equal((await merge('w/A2')).code, 0);
  assert.deepEqual(merges().slice(2), ['o/r#10']);
  assert.equal(thread('A2').at(-1), 'Merged PR #10.');
  writePR(dir, 'o/r#11', ready);
  writePR(dir, 'o/site#3', ready);
  writeMerge(dir, 'o/site#3', { error: 'Base branch was modified.' });
  assert.deepEqual(await merge('w/A3'), { code: 1, out: '', err: 'gh pr merge o/site#3 failed: Base branch was modified. (merged #11 before it)\n' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[2].lane, undefined);
  writePR(dir, 'o/r#11', prView({ state: 'MERGED' }));
  writePR(dir, 'o/site#3', prView({ state: 'CLOSED' }));
  assert.equal((await merge('w/A3')).code, 0);
  assert.equal(thread('A3').at(-1), 'PR #11 was already merged.');
});

test('land refuses a new ADR named with a number instead of a timestamp, naming it and the name to use, and changes nothing; numbered ADRs already on main pass', async () => {
  const repo = scratchRepo();
  commit(repo, 'docs/adr/0007-old.md', '# Old\n');
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'docs/adr/2026-11-03-1111-fine.md', '# Fine\n');
  commit(worktree(), 'docs/adr/0008-numbered-again.md', '# Numbered again\n');
  const main = git(repo, 'rev-parse', 'main');
  const r = await land();
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'land: docs/adr/0008-numbered-again.md is named with a number; name it docs/adr/YYYY-MM-DD-HHMM-numbered-again.md, the time you wrote it, and land again\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(git(worktree(), 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(worktree()));
  assert.ok(branches(repo).includes('A1'));

  git(worktree(), 'mv', 'docs/adr/0008-numbered-again.md', 'docs/adr/2026-11-03-1112-numbered-again.md');
  git(worktree(), 'commit', '--quiet', '-m', 'name it by time');
  const landed = await land();
  assert.equal(landed.code, 0, landed.err);
  assert.deepEqual(fs.readdirSync(path.join(repo, 'docs', 'adr')).sort(), ['0007-old.md', '2026-11-03-1111-fine.md', '2026-11-03-1112-numbered-again.md']);
});

// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
// docs/adr/2026-11-11-2318-every-land-squashes-the-branch-into-one-commit.md
test("land --site refuses a squash message whose subject isn't Conventional or runs past 100 characters, or that still holds a \"# Conflicts:\" note, naming the commit it comes from, and changes nothing; one with no Refs trailer gets the card's", async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  const landOn = () => boardWith(['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  const say = (message) => { write(path.join(worktree(), 'card.txt'), message); git(worktree(), 'add', '-A'); git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '-m', message); return git(worktree(), 'rev-parse', '--short', 'HEAD'); };
  const refused = async (message) => {
    const c = say(message);
    const r = await landOn();
    git(worktree(), 'reset', '--quiet', '--hard', 'main');
    return [r.code, r.err.replace(c, '<c>')];
  };
  const main = git(repo, 'rev-parse', 'main');

  const shape = (subject) => [1, `land: commit <c> "${subject}" isn't "<type>(<scope>): <summary>" with the type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert and a lowercase scope; reword it to the commit standard and land again\n`];
  assert.deepEqual(await refused('A1: the old form\n\nRefs: A1'), shape('A1: the old form'));
  assert.deepEqual(await refused('feature(board): x\n\nRefs: A1'), shape('feature(board): x'));
  const long = `feat(board): ${'x'.repeat(88)}`;
  assert.deepEqual(await refused(`${long}\n\nRefs: A1`), [1, `land: commit <c> "${long}" is 101 characters, over 100; reword it to the commit standard and land again\n`]);

  const noted = say('fix: fine\n\nRefs: A1\nCo-Authored-By: X\n\n# Conflicts:\n#\tshared/notes.md');
  const r = await landOn();
  assert.deepEqual([r.code, r.out, r.err], [1, '', `land: commit ${noted} "fix: fine" still holds a "# Conflicts:" note in its message; amend it out and land again\n`]);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.ok(fs.existsSync(worktree()));

  assert.equal(git(worktree(), 'rev-parse', '--short', 'HEAD'), noted);

  // Land writes the trailer block: the card's Refs, then each Co-Authored-By, with no blank line between.
  git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '--amend', '-m', 'fix(board)!: fine\n\nThe detail.\n\nRefs: A2\n\nCo-Authored-By: X');
  const landed = await landOn();
  assert.equal(landed.code, 0, landed.err);
  assert.equal(git(repo, 'log', '-1', '--format=%B', 'main').trim(), 'fix(board)!: fine\n\nThe detail.\n\nRefs: A1\nCo-Authored-By: X');
});

// docs/adr/2026-11-11-2318-every-land-squashes-the-branch-into-one-commit.md
test("every land squashes the card's branch into one commit on main: --title else the first commit's subject, the first commit's detail, the card's Refs over each Co-Authored-By once; a fix-up's and a helper merge's messages are dropped", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  const main = git(repo, 'rev-parse', 'main');
  commit(worktree(), 'work.txt', 'built\n', 'feat(board): work\n\nThe detail.\n\nRefs: A1\n\nCo-Authored-By: Claude <c@x>');
  git(worktree(), 'switch', '--quiet', '-c', 'helper');
  commit(worktree(), 'helper.txt', 'helped\n', 'test: helper tests\n\nCo-Authored-By: Ann <ann@x>');
  git(worktree(), 'switch', '--quiet', 'A1');
  commit(worktree(), 'fix.txt', 'fixed\n', 'review fixes\n\nCo-Authored-By: Claude <c@x>');
  git(worktree(), 'merge', '--quiet', '--no-ff', '-m', 'chore: merge the tests helper branch', 'helper');
  git(worktree(), 'branch', '--quiet', '-D', 'helper');
  const head = git(worktree(), 'rev-parse', 'HEAD');
  const tree = git(worktree(), 'rev-parse', 'HEAD^{tree}');

  const badTitle = await onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.', '--title', 'Work');
  assert.equal(badTitle.code, 1);
  assert.match(badTitle.err, /^--title "Work" isn't "<type>\(<scope>\): <summary>".*; pass --title "<type>\(<scope>\): <summary>", at most 100 characters\n$/);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD')], [main, head]);

  const r = await onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.', '--title', 'feat(board): the title');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(repo, 'rev-parse', 'main~1'), main);
  assert.equal(git(repo, 'rev-parse', 'main^{tree}'), tree);
  assert.equal(git(repo, 'log', '-1', '--format=%B', 'main').trim(), 'feat(board): the title\n\nThe detail.\n\nRefs: A1\nCo-Authored-By: Claude <c@x>\nCo-Authored-By: Ann <ann@x>');
  assert.equal(itemOf().lane, 'done');
});

test('a branch already one commit with the squash message lands as that commit, unrewritten', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nThe detail.\n\nRefs: A1\nCo-Authored-By: X');
  const head = git(worktree(), 'rev-parse', 'HEAD');
  const r = await boardWith(['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], finishEnv);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(repo, 'rev-parse', 'main'), head);
});

test('land refuses a worktree with uncommitted changes, with no commit beyond main, or whose suite fails, leaving main and the worktree as they were', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  const main = git(repo, 'rev-parse', 'main');
  const lock = at('kickflip', 'land.lock');
  // A refusal while preparing never reaches the land lock (docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md).
  write(lock, { card: 'B2', pid: process.pid, at: '2026-11-02T10:00:00.000Z' });
  const none = await land();
  assert.deepEqual([none.code, none.err], [1, 'A1 has no commits beyond main; nothing to land\n']);
  assert.equal(read(lock).card, 'B2');
  fs.rmSync(lock);
  commit(worktree(), 'gone.txt', 'gone\n');
  git(worktree(), 'rm', '--quiet', 'gone.txt');
  git(worktree(), 'commit', '--quiet', '-m', 'drop it');
  const head = git(worktree(), 'rev-parse', 'HEAD');
  const nothing = await land();
  assert.deepEqual([nothing.code, nothing.err, git(worktree(), 'rev-parse', 'HEAD')], [1, "A1's commits change nothing beyond main; nothing to land\n", head]);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  const dirty = await land();
  assert.deepEqual([dirty.code, dirty.err], [1, `${worktree()} has uncommitted changes; commit them there first\n`]);
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '-m', 'board');
  commit(worktree(), 'bad.test.mjs', "import test from 'node:test';\ntest('fixture suite', async (t) => {\n  await t.test('bad fixture', () => { throw new Error('fixture error\\nsecond error line\\nthird error line\\nfourth error line'); });\n});\n");
  commit(worktree(), 'other.test.mjs', "import test from 'node:test';\ntest('other failing fixture', () => { console.error('fixture stderr'); throw new Error('other fixture error'); });\n");
  commit(worktree(), 'crash.test.mjs', "throw new Error('fixture module crash');\n");
  const failing = await land();
  assert.equal(failing.code, 1);
  assert.match(failing.err, /tests failed in .* \(4 failing\); nothing landed/);
  assert.match(failing.err, /fixture suite > bad fixture/);
  assert.match(failing.err, /other failing fixture/);
  assert.match(failing.err, /other fixture error/);
  assert.match(failing.err, /Error: fixture module crash/);
  assert.ok(failing.err.includes(path.join(worktree(), 'crash.test.mjs')));
  assert.ok(failing.err.includes(path.join(worktree(), 'other.test.mjs')));
  assert.ok(failing.err.includes(path.join(worktree(), 'bad.test.mjs')));
  assert.match(failing.err, /fixture error\n.*second error line\n.*third error line/);
  assert.doesNotMatch(failing.err, /fourth error line/);
  const log = failing.err.match(/Full test output: (.+)\n/)?.[1];
  assert.ok(log);
  assert.equal(path.dirname(log), at('kickflip', 'logs'));
  const tap = fs.readFileSync(log, 'utf8');
  assert.match(tap, /^TAP version 13\n/);
  assert.match(tap, /not ok .*bad fixture/);
  assert.match(tap, /fourth error line/);
  assert.match(tap, /fixture stderr/);
  assert.equal(git(worktree(), 'status', '--porcelain'), '');
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.ok(fs.existsSync(worktree()));
  assert.ok(branches(repo).includes('A1'));
  assert.deepEqual(restarts(), []);
});

test("a local board, or one with no GitHub repo or git remote, branches from its own folder's local branch and lands there, never kickflip's clone", async () => {
  scratchRepo();
  const project = path.join(home, 'local-project');
  fs.mkdirSync(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  commit(project, 'project.txt', 'pushed');
  git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(project, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  commit(project, 'landed.txt', 'only on local main');
  const setOrch = (fields) => {
    const manifest = read(at('kickflip', 'manifest.json'));
    manifest.sites.orch = { dir: manifest.sites.orch.dir, port: 1, cmd: manifest.sites.orch.cmd, ...fields };
    write(at('kickflip', 'manifest.json'), manifest);
  };
  const reset = () => { git(project, 'worktree', 'remove', '--force', worktree()); git(project, 'branch', '--quiet', '-D', 'A1'); };
  for (const fields of [{ owner: { repo: project } }, { github: 'owner/project', branch: 'main', local: true, owner: { repo: project } }]) {
    setOrch(fields);
    const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: project });
    assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'main'));
    reset();
  }

  setOrch({});
  const none = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.deepEqual([none.code, none.err], [1, '/orch has no folder recorded for its session; rejoin it from its repo folder\n']);

  setOrch({ owner: { repo: project } });
  fs.rmSync(at('waves', 'w', 'agents'), { recursive: true });
  git(project, 'worktree', 'add', '--quiet', '-b', 'A1', worktree(), 'main');
  commit(worktree(), 'card.txt', 'card', 'feat: task\n\nRefs: A1');
  const landed = await boardWith(['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  assert.equal(landed.code, 0, landed.err);
  assert.match(landed.out, new RegExp(`main fast-forwarded to \\w+ in ${project}`));
  assert.equal(fs.readFileSync(path.join(project, 'card.txt'), 'utf8'), 'card');
});

test('a local board whose recorded branch is trunk branches from trunk and lands there, refusing while its folder is on another branch, naming trunk', async () => {
  scratchRepo();
  const project = path.join(home, 'trunk-project');
  fs.mkdirSync(project);
  git(project, 'init', '--quiet', '-b', 'trunk');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  commit(project, 'project.txt', 'trunk');
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch = { dir: manifest.sites.orch.dir, port: 1, cmd: manifest.sites.orch.cmd, local: true, branch: 'trunk', owner: { repo: project } };
  write(at('kickflip', 'manifest.json'), manifest);
  const started = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(started.code, 0, started.err);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'trunk'));
  commit(worktree(), 'card.txt', 'card', 'feat: task\n\nRefs: A1');

  git(project, 'switch', '--quiet', '-c', 'feature');
  const landTrunk = () => boardWith(['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  const refused = await landTrunk();
  assert.deepEqual([refused.code, refused.err], [1, `${project} is on feature, not trunk; switch it to trunk (git -C ${project} switch trunk) and land again\n`]);

  git(project, 'switch', '--quiet', 'trunk');
  commit(project, 'moved.txt', 'trunk moved');
  const moved = git(project, 'rev-parse', '--short', 'trunk');
  const landed = await landTrunk();
  assert.equal(landed.code, 0, landed.err);
  const tip = git(project, 'rev-parse', '--short', 'trunk');
  assert.deepEqual(landed.out.trim().split('\n').slice(0, 4), [`rebased A1 onto trunk (${moved})`, 'testing every test file, as card.txt reaches no test', 'tests passed: 0', `trunk fast-forwarded to ${tip} in ${project}`]);
  assert.equal(fs.readFileSync(path.join(project, 'card.txt'), 'utf8'), 'card');
  assert.equal(git(project, 'rev-parse', 'trunk~1'), git(project, 'rev-parse', moved));
});

test('land keeps a message line starting with "#" through its rebase', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  git(worktree(), 'add', '-A');
  git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '-m', 'feat: subject\n\n#7 starts this line.\n\nRefs: #7');
  commit(repo, 'shared/notes.md', 'b\n');
  const before = git(repo, 'rev-parse', 'main');
  const r = await land();
  assert.equal(r.code, 0, r.err);
  assert.equal(git(repo, 'log', '-1', '--format=%B', 'main'), 'feat: subject\n\n#7 starts this line.\n\nRefs: #7');
  assert.equal(git(repo, 'rev-parse', 'main~1'), before);
});

test('land refuses a commit with an empty subject, naming it, and leaves main as it was', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '--allow-empty-message', '--cleanup=verbatim', '-m', '');
  const sha = git(worktree(), 'rev-parse', '--short', 'HEAD');
  const main = git(repo, 'rev-parse', 'main');
  const r = await land();
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`empty subject \\(${sha}\\)`));
  assert.equal(git(repo, 'rev-parse', 'main'), main);
});

test('land rebases onto a moved main, fast-forwards main, and removes the worktree and branch; a repo other than the running kickflip clone restarts nothing', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'board/server.mjs', '2\n');
  commit(worktree(), 'hub/hub.mjs', "import { a } from '../shared/lib.mjs';\n// 2\n");
  commit(repo, 'shared/notes.md', 'b\n');
  const moved = git(repo, 'rev-parse', '--short', 'main');
  const r = await land();
  assert.equal(r.code, 0, r.err);
  const main = git(repo, 'rev-parse', '--short', 'main');
  assert.deepEqual(r.out.trim().split('\n'), [
    `rebased A1 onto main (${moved})`, 'testing every test file, as board/server.mjs reaches no test', 'tests passed: 1',
    `main fast-forwarded to ${main} in ${repo}`,
    `worktree removed: ${worktree()}`, 'branch deleted: A1',
  ]);
  assert.equal(git(repo, 'rev-parse', 'main~1'), git(repo, 'rev-parse', moved));
  assert.equal(git(repo, 'log', '-1', '--format=%B', 'main').trim(), 'change board/server.mjs');
  assert.equal(fs.readFileSync(path.join(repo, 'board', 'server.mjs'), 'utf8'), '2\n');
  assert.deepEqual(restarts(), []);
  assert.equal(fs.existsSync(worktree()), false);
  assert.deepEqual(branches(repo), ['main']);
});

test("land into the running kickflip clone restarts only the code that changed: the hub for its code, else every board for board/, nothing for tests or docs", async (t) => {
  // In process, so HOME is pointed at the test's home: the land's lock is then not the host's.
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const repo = scratchRepo();
  const restarted = [];
  const landHere = async () => {
    const said = [];
    await landWorktree({ path: worktree(), branch: 'A1', repo, base: 'main' }, {
      clone: repo, say: (line) => said.push(line), runTests: () => ({ ok: true, pass: 1 }),
      restart: (what, route) => { restarted.push([what, route].filter(Boolean).join(' ')); return null; },
      boards: () => [{ route: 'orch' }, { route: 'audit' }],
    });
    return said;
  };
  const card = async (...files) => {
    assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
    for (const [file, text] of files) commit(worktree(), file, text);
    return landHere();
  };
  assert.ok((await card(['board/server.mjs', '2\n'])).includes('board restarted: audit'));
  assert.deepEqual(restarted, ['board orch', 'board audit']);
  assert.ok((await card(['shared/lib.mjs', 'export const a = 2;\n'], ['board/server.mjs', '3\n'])).includes('hub restarted, with every site'));
  assert.deepEqual(restarted, ['board orch', 'board audit', 'hub']);
  const tests = await card(['hub/hub.test.mjs', '// t\n'], ['board/server.test.mjs', '// t\n'], ['shared/notes.md', 'c\n']);
  assert.equal(tests.some((line) => /restarted/.test(line)), false);
  assert.deepEqual(restarted, ['board orch', 'board audit', 'hub']);
});

test('land on --site needs --text, refuses before landing what closing would refuse, and closes the card as done once it lands', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n', 'feat: notes\n\nRefs: A1');
  const landOn = (...more) => boardWith(['land', 'w/A1', '--site', 'orch', ...more], {
    KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']),
  });
  assert.equal((await landOn()).code, 2);
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [question('q1', { topic: 'item:w/A1' })] });
  const main = git(repo, 'rev-parse', 'main');
  const open = await landOn('--text', 'Checked on the phone.');
  assert.equal(open.code, 1);
  assert.match(open.err, /^land: w\/A1 has an open question q1 with no answer yet/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' } });
  const r = await landOn('--text', 'Checked on the phone.');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.deepEqual(r.out.trim().split('\n').slice(-2), ['A1: landed and done', 'resolved: q1']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'done');
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Checked on the phone.');
  assert.ok(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).some((m) => m.kind === 'status' && m.phase === 'landing'), 'the finish itself sets the landing phase');
});

test('land --owner-step lands the code and leaves the card open on its owner step and its check; a blank step or a bad check is refused before landing', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n', 'feat: notes\n\nRefs: A1');
  const landOn = (...more) => boardWith(['land', 'w/A1', '--site', 'orch', '--text', 'Checked on the phone.', ...more], {
    KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']),
  });
  const main = git(repo, 'rev-parse', 'main');
  assert.deepEqual([(await landOn('--owner-step', ' ')).code, (await landOn('--owner-step', ' ')).err], [1, '--owner-step must be non-empty text\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  const badCheck = await landOn('--owner-step', 'Tag the first release', '--check', 'tag nowhere v*');
  assert.deepEqual([badCheck.code, badCheck.err], [1, `--check tag <owner/repo> <pattern>: "nowhere" isn't a GitHub repo such as owner/name\n`]);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  const r = await landOn('--owner-step', 'Tag the first release', '--check', 'tag o/r v*');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(r.out.trim().split('\n').at(-1), 'A1: landed; waits on the owner step "Tag the first release"');
  const item = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([item.lane, item.owner_step, item.owner_check.check], ['done', 'Tag the first release', 'tag o/r v*']);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Checked on the phone.');
});

test("builder done on a card whose PR link a reviewer has goes through with nothing queued for Slack, and review updated is gone", async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7 }] });
  const slackRecord = { 'o/r#7': { links: { Ann: { channel: 'D1', ts: '1.1', reactions: [] } }, replies: [] } };
  write(site('orch', 'data', 'pr-slack.json'), slackRecord);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  const updated = await board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it', '--updated', 'limits reset per key');
  assert.notEqual(updated.code, 0);
  assert.match(updated.err, /--updated/);
  const done = await board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(read(site('orch', 'data', 'pr-slack.json')), slackRecord);
  assert.notEqual((await board('review', 'updated', 'w/A1', '--site', 'orch', '--text', 'x')).code, 0);
});

test('builder done --owner-step records the step on the card, and refuses one on a card already closed, naming land', async () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, ...extra }] });
  items({});
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  const done = await board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag the first release');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out.trim(), 'A1: builder done; owner step "Tag the first release"');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, 'Tag the first release');
  items({ lane: 'done', closed_at: '2026-11-01T10:00:00Z' });
  const late = await board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it');
  assert.deepEqual([late.code, late.err], [1, 'w/A1 is already Done, so its ticket closed; an owner step goes on the command that finishes the task: land --owner-step, or builder done before the merge\n']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, undefined);
});

// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
test('builder done --check attaches a named check to the owner step, refusing one without the step or with bad arguments', async () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, ...extra }] });
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  items({});
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  const alone = await board('builder', 'done', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.equal(alone.code, 2);
  assert.match(alone.err, /--check goes with --owner-step/);
  const shell = await board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag a release', '--check', 'sh -c "rm -rf ~"');
  assert.equal(shell.code, 1);
  assert.match(shell.err, /^--check has no check "sh"; it takes tag <owner\/repo> <pattern>/);
  assert.equal(item().owner_step, undefined);
  const done = await board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag a release', '--check', 'npm  kickflip 0.3.*');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual([item().owner_step, item().owner_check.check], ['Tag a release', 'npm kickflip 0.3.*']);
  assert.ok(Date.parse(item().owner_check.since) <= Date.now());
});

test('item set --check changes or removes the check on a card waiting on its owner step, clearing a broken mark, and refuses a card with no step', async () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'done', closed_at: '2026-11-01T10:00:00Z', ...extra }] });
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  items({});
  const none = await board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.deepEqual([none.code, none.err], [1, `--check goes with an owner step, which w/A1 doesn't have: pass --owner-step "<the step>" with it on builder done or land\n`]);
  const since = '2026-11-04T10:00:00.000Z';
  items({ owner_step: 'Publish it', owner_check: { check: 'npm kickflip 0.3.*', since, broken: 'npm view failed: E404' } });
  const again = await board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out.trim(), 'A1: check npm kickflip 0.3.*');
  assert.deepEqual(item().owner_check, { check: 'npm kickflip 0.3.*', since });
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'tag o/r v0.3.*')).code, 0);
  assert.equal(item().owner_check.check, 'tag o/r v0.3.*');
  assert.notEqual(item().owner_check.since, since);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--check', '')).code, 0);
  assert.deepEqual([item().owner_step, item().owner_check], ['Publish it', undefined]);
});

test("land refuses while a builder record on the card has unverified judgment calls, naming builder verified, and lands once they're verified", async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'fix')).code, 0);
  assert.equal((await board('builder', 'call', 'w/A1', '--agent', 'fix', 'Kept the old name')).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n');
  const main = git(repo, 'rev-parse', 'main');
  const refused = await land();
  assert.deepEqual([refused.code, refused.err], [1, 'land: w/A1 has judgment calls nobody verified yet; check them with builder calls w/A1 --agent fix, then run builder verified w/A1 --agent fix\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal((await board('builder', 'verified', 'w/A1', '--agent', 'fix')).code, 0);
  const r = await land();
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
});

test('land skips tests inside .repos and node_modules at every depth', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  const ignored = "import test from 'node:test';\ntest('foreign test', () => { throw new Error('foreign suite ran'); });\n";
  for (const directory of ['.repos/owner/repo', 'node_modules/dependency', 'nested/.repos/owner/repo', 'nested/node_modules/dependency']) {
    write(path.join(worktree(), directory, 'foreign.test.mjs'), ignored);
  }
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '-m', 'foreign repos');
  const result = await land();
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /tests passed: 1/);
  assert.equal(fs.existsSync(worktree()), false);
});

test('land refuses a rebase that conflicts, naming the files, and leaves the branch, worktree and main as they were', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n');
  commit(repo, 'shared/notes.md', 'main\n');
  const [main, head] = [git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD')];
  const r = await land();
  assert.deepEqual([r.code, r.err], [1, `rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again\n`]);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD'), git(worktree(), 'status', '--porcelain')], [main, head, '']);
  assert.equal(fs.readFileSync(path.join(worktree(), 'shared', 'notes.md'), 'utf8'), 'branch\n');
  assert.deepEqual(restarts(), []);
});

// docs/adr/2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md
test("a land tags a release commit as it landed, after the rebase, and pushes the tag after main when Push release tags is on; it refuses a release whose package.json disagrees or whose tag is on another commit", async () => {
  const repo = scratchRepo();
  const ids = ['A1', 'A2', 'A3', 'A4', 'A5'];
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: ids.map((id) => ({ id, title: `chore(release): ${id}` })) });
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  commit(repo, 'package.json', JSON.stringify({ name: 'x', version: '0.1.0' }) + '\n', 'chore(release): 0.1.0');
  git(repo, 'push', '--quiet', 'origin', 'main');
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  const allow = (...rules) => write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: rules } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  allow('Bash(git push origin main)', 'Bash(git push origin v*)');
  const release = async (id, version, subject = `chore(release): ${version}`) => {
    assert.equal((await onOrch('builder', 'start', `w/${id}`, '--kind', 'build')).code, 0);
    commit(at('kickflip', 'worktrees', id), 'package.json', JSON.stringify({ name: 'x', version }) + '\n', `${subject}\n\n- feat: work\n\nRefs: ${id}`);
    return await onOrch('builder', 'done', `w/${id}`, '--text', 'Checked it.');
  };
  const tagged = (where, tag) => git(where, 'tag', '--list', tag) && git(where, 'rev-parse', `${tag}^{commit}`);

  assert.equal((await onOrch('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(at('kickflip', 'worktrees', 'A1'), 'package.json', JSON.stringify({ name: 'x', version: '0.2.0' }) + '\n', 'chore(release): 0.2.0\n\nRefs: A1');
  commit(repo, 'other.txt', 'moved\n', 'feat: main moved\n\nRefs: A0');
  git(repo, 'push', '--quiet', 'origin', 'main');
  const landed = await onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(landed.code, 0, landed.err);
  assert.ok(landed.out.includes('\npushed main to origin\npushed v0.2.0 to origin\n'), landed.out);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), 'chore(release): 0.2.0');
  assert.equal(tagged(repo, 'v0.2.0'), git(repo, 'rev-parse', 'main'), 'the tag is on the landed commit, after the rebase');
  assert.equal(tagged(origin, 'v0.2.0'), git(repo, 'rev-parse', 'main'));

  const mismatch = await release('A2', '0.2.5', 'chore(release): 0.3.0');
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.err, /^land: "chore\(release\): 0\.3\.0" is a release, but package\.json's version there is 0\.2\.5; bump it to 0\.3\.0 with node scripts\/release\.mjs and land again/);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), 'chore(release): 0.2.0', 'nothing landed');

  git(repo, 'tag', 'v0.4.0', 'main~1');
  const taken = await release('A3', '0.4.0');
  assert.equal(taken.code, 1);
  assert.match(taken.err, new RegExp(`^land: tag v0\\.4\\.0 is already on ${git(repo, 'rev-parse', '--short', 'main~1')}, not this release; release another version, or delete the tag if it was never pushed \\(git -C .+ tag -d v0\\.4\\.0\\), and land again`));
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), 'chore(release): 0.2.0', 'nothing landed');

  allow('Bash(git push origin main)');
  const local = await release('A4', '0.5.0');
  assert.equal(local.code, 0, local.err);
  assert.match(local.out, /\npushed main to origin\nv0\.5\.0 stays local while Push release tags is off; push it with git -C .+ push origin v0\.5\.0\n/);
  assert.equal(tagged(repo, 'v0.5.0'), git(repo, 'rev-parse', 'main'));
  assert.equal(tagged(origin, 'v0.5.0'), '');

  allow('Bash(git push origin main)', 'Bash(git push origin v*)');
  write(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/tags/*) echo "no tags here" >&2; exit 1;; esac; done\n');
  fs.chmodSync(path.join(origin, 'hooks', 'pre-receive'), 0o755);
  const refused = await release('A5', '0.6.0');
  assert.equal(refused.code, 0, refused.err);
  assert.match(refused.out, /\npushed main to origin\nlanded, but v0\.6\.0 didn't reach origin: [\s\S]+; push it with git -C .+ push origin v0\.6\.0\n/);
  assert.equal(itemOf('A5').lane, 'done');
  assert.match(threadOf('A5').at(-1).text, /^Landed, but v0\.6\.0 didn't reach origin: /);
});

// docs/adr/2026-11-15-0715-a-merge-mode-done-card-shows-its-commit-as-a-badge.md
test('a land records the commit it fast-forwarded main to on the card', async () => {
  const repo = scratchRepo();
  assert.equal((await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'card.txt', 'card', 'feat: task\n\nRefs: A1');
  const landed = await boardWith(['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  assert.equal(landed.code, 0, landed.err);
  assert.equal(itemOf('A1').landed_sha, git(repo, 'rev-parse', 'main'));
});
