import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { until } from '../shared/test-helpers.mjs';
import { land as landWorktree } from './worktree.mjs';
import { opensPRs, settingsOf } from './store.mjs';
import { fakeGh, prView, writePR, writeReviews, writeMerge, calls } from '../shared/fake-gh.mjs';
import { bin, home, at, site, write, read, lines, run, board, wave, question, git, commit, scratchRepo, heldBoard, worktree, restarts, land, branches, finishEnv, onOrch, record, itemOf, threadOf, remoteBoard, tapMerge, addEvents } from './board-fixture.mjs';

test("merge squashes a card's PR once GitHub would merge it, with no commit after the approval unexplained and manual steps on the owner's word, and leaves its refusal off the card's thread", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => run('board.mjs', ['--site', 'orch', 'merge', ...args], undefined, env);
  const thread = () => (fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')) ? lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text) : []);
  const merges = () => calls(dir).filter((a) => a[1] === 'merge');
  const approved = (commit) => writeReviews(dir, 7, [{ id: 1, user: { login: 'ann' }, state: 'APPROVED', submitted_at: '2026-11-01T10:00:00Z', commit_id: commit }]);
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, lane: 'progress', manual_steps: ['Run the backfill'] }, { id: 'A2', title: 'Two', pr: 8 }, { id: 'A3', title: 'Three' }] });
  writePR(dir, 7, prView({ failing: ['build'], pending: 1 }));
  assert.deepEqual(merge('w/A1'), { code: 1, out: '', err: "Not merged: review: review required; failing: build; merge state: blocked; manual steps: merge only on the owner's word, with --confirmed \"<their words>\".\n" });
  assert.deepEqual(thread(), []);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), [
    { id: 'e3', ts: '2026-11-01T11:01:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'The backfill ran on prod.' } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', head: 'bbb' }));
  approved('aaa');
  const after = merge('w/A1', '--confirmed', 'the backfill ran on prod');
  assert.equal(after.code, 1);
  assert.match(after.err, /^Not merged: commits after the approval: pass --after-approval/);
  assert.deepEqual(thread(), []);
  assert.match(merge('w/A1', '--after-approval', 'Rebased.', '--confirmed', 'the backfill is done').err, /--confirmed must quote the owner's words/);
  approved('bbb');
  assert.match(merge('w/A1', '--after-approval', 'Rebased.', '--confirmed', 'the backfill ran on prod').err, /--after-approval: no commit came after the approval/);
  writePR(dir, 8, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  assert.match(merge('w/A2', '--confirmed', 'the backfill ran on prod').err, /--confirmed: w\/A2 has no manual steps/);
  assert.match(merge('w/A3').err, /w\/A3 has no PR/);
  writeMerge(dir, 8, { error: 'Pull request is not mergeable: the base branch policy prohibits the merge.' });
  assert.deepEqual(merge('w/A2'), { code: 1, out: '', err: 'gh pr merge #8 failed: Pull request is not mergeable: the base branch policy prohibits the merge.\n' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[1].lane, undefined);
  assert.equal(merges().length, 1);
  approved('aaa');
  const done = merge('w/A1', '--after-approval', 'Only a rebase onto main.', '--confirmed', 'the backfill ran on prod');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out.trim().split('\n').at(-1), 'A1: merged');
  assert.deepEqual(merges().at(-1), ['pr', 'merge', '7', '--repo', 'o/r', '--squash']);
  const merged = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([merged.lane, merged.prs.map((p) => [p.number, typeof p.merged_at])], ['done', [[7, 'string']]]);
  assert.equal(thread().at(-1), 'Merged PR #7. After the approval: Only a rebase onto main. The owner\'s word on the manual steps: "the backfill ran on prod"');
  writePR(dir, 8, prView({ state: 'MERGED' }));
  assert.equal(merge('w/A2').code, 0);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A2.jsonl')).at(-1).text, 'PR #8 was already merged.');
  assert.equal(merges().length, 2);
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("merge counts commits after the approval as trivial when the board's rebase runs pushed them, and says so", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => run('board.mjs', ['--site', 'orch', 'merge', ...args], undefined, env);
  const rebased = (...steps) => write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7,
    rebased: steps.map(([from, to, replayed = true]) => ({ from, to, base: 'main', replayed, at: '2026-11-05T10:00:00Z' })) }] });
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', head: 'ccc' }));
  writeReviews(dir, 7, [{ id: 1, user: { login: 'ann' }, state: 'APPROVED', submitted_at: '2026-11-01T10:00:00Z', commit_id: 'aaa' }]);
  rebased(['zzz', 'ccc']);
  assert.match(merge('w/A1').err, /^Not merged: commits after the approval/, "a run that didn't start from the approved commit isn't the only change");
  rebased(['aaa', 'bbb'], ['bbb', 'ccc', false]);
  assert.match(merge('w/A1').err, /^Not merged: commits after the approval/, 'a run that added commits of its own made no rebase-only push');
  rebased(['aaa', 'bbb'], ['bbb', 'ccc']);
  const done = merge('w/A1');
  assert.equal(done.code, 0, done.err);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, "Merged PR #7. After the approval: only the board's rebase onto main.");
});

test("merge takes every PR on a card across repos in its order, refusing while any open one isn't ready and leaving a merged or closed one be", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => run('board.mjs', ['--site', 'orch', 'merge', ...args], undefined, env);
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
  const refused = merge('w/A1');
  assert.equal(refused.code, 1);
  assert.equal(refused.err, 'Not merged: o/site#1 it is a draft; o/site#1 review: review required; o/site#1 failing: build; o/site#1 merge state: blocked.\n');
  assert.deepEqual(merges(), []);
  writePR(dir, 'o/site#1', ready);
  const done = merge('w/A1');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(merges(), ['o/r#6', 'o/site#1']);
  const merged = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([merged.lane, merged.prs.map((p) => typeof p.merged_at)], ['done', ['string', 'string']]);
  assert.equal(thread('A1').at(-1), 'Merged PRs #6, o/site#1.');
  writePR(dir, 'o/site#2', prView({ state: 'MERGED' }));
  writePR(dir, 'o/r#9', prView({ state: 'CLOSED' }));
  writePR(dir, 'o/r#10', ready);
  assert.equal(merge('w/A2').code, 0);
  assert.deepEqual(merges().slice(2), ['o/r#10']);
  assert.equal(thread('A2').at(-1), 'Merged PR #10.');
  writePR(dir, 'o/r#11', ready);
  writePR(dir, 'o/site#3', ready);
  writeMerge(dir, 'o/site#3', { error: 'Base branch was modified.' });
  assert.deepEqual(merge('w/A3'), { code: 1, out: '', err: 'gh pr merge o/site#3 failed: Base branch was modified. (merged #11 before it)\n' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[2].lane, undefined);
  writePR(dir, 'o/r#11', prView({ state: 'MERGED' }));
  writePR(dir, 'o/site#3', prView({ state: 'CLOSED' }));
  assert.equal(merge('w/A3').code, 0);
  assert.equal(thread('A3').at(-1), 'PR #11 was already merged.');
});

test('land refuses a new ADR named with a number instead of a timestamp, naming it and the name to use, and changes nothing; numbered ADRs already on main pass', () => {
  const repo = scratchRepo();
  commit(repo, 'docs/adr/0007-old.md', '# Old\n');
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'docs/adr/2026-11-03-1111-fine.md', '# Fine\n');
  commit(worktree(), 'docs/adr/0008-numbered-again.md', '# Numbered again\n');
  const main = git(repo, 'rev-parse', 'main');
  const r = land();
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'land: docs/adr/0008-numbered-again.md is named with a number; name it docs/adr/YYYY-MM-DD-HHMM-numbered-again.md, the time you wrote it, and land again\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(git(worktree(), 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(worktree()));
  assert.ok(branches(repo).includes('A1'));

  git(worktree(), 'mv', 'docs/adr/0008-numbered-again.md', 'docs/adr/2026-11-03-1112-numbered-again.md');
  git(worktree(), 'commit', '--quiet', '-m', 'name it by time');
  const landed = land();
  assert.equal(landed.code, 0, landed.err);
  assert.deepEqual(fs.readdirSync(path.join(repo, 'docs', 'adr')).sort(), ['0007-old.md', '2026-11-03-1111-fine.md', '2026-11-03-1112-numbered-again.md']);
});

test("land --site refuses a commit whose subject doesn't start with the card's ref and a colon, and one whose message still holds a \"# Conflicts:\" note, naming the commit, and changes nothing", () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  const landOn = () => run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  const say = (message) => { write(path.join(worktree(), 'card.txt'), message); git(worktree(), 'add', '-A'); git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '-m', message); return git(worktree(), 'rev-parse', '--short', 'HEAD'); };
  const main = git(repo, 'rev-parse', 'main');

  const bare = say('no ref here');
  assert.deepEqual([landOn().code, landOn().err], [1, `land: commit ${bare} "no ref here" doesn't start with "A1: "; reword it and land again\n`]);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');

  const noSpace = say('A1:no space');
  assert.match(landOn().err, new RegExp(`^land: commit ${noSpace} "A1:no space" doesn't start with`));
  git(worktree(), 'reset', '--quiet', '--hard', 'main');

  const noted = say('A1: fine\n\nCo-Authored-By: X\n\n# Conflicts:\n#\tshared/notes.md');
  const r = landOn();
  assert.deepEqual([r.code, r.out, r.err], [1, '', `land: commit ${noted} "A1: fine" still holds a "# Conflicts:" note in its message; amend it out and land again\n`]);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.ok(fs.existsSync(worktree()));

  git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '--amend', '-m', 'A1: fine\n\nCo-Authored-By: X');
  const landed = landOn();
  assert.equal(landed.code, 0, landed.err);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), 'A1: fine');
});

test('land refuses a worktree with uncommitted changes, with no commit beyond main, or whose suite fails, leaving main and the worktree as they were', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  const main = git(repo, 'rev-parse', 'main');
  const lock = at('kickflip', 'land.lock');
  // A refusal while preparing never reaches the land lock (docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md).
  write(lock, { card: 'B2', pid: process.pid, at: '2026-11-02T10:00:00.000Z' });
  const none = land();
  assert.deepEqual([none.code, none.err], [1, 'A1 has no commits beyond main; nothing to land\n']);
  assert.equal(read(lock).card, 'B2');
  fs.rmSync(lock);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  const dirty = land();
  assert.deepEqual([dirty.code, dirty.err], [1, `${worktree()} has uncommitted changes; commit them there first\n`]);
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '-m', 'board');
  commit(worktree(), 'bad.test.mjs', "import test from 'node:test';\ntest('fixture suite', async (t) => {\n  await t.test('bad fixture', () => { throw new Error('fixture error\\nsecond error line\\nthird error line\\nfourth error line'); });\n});\n");
  commit(worktree(), 'other.test.mjs', "import test from 'node:test';\ntest('other failing fixture', () => { console.error('fixture stderr'); throw new Error('other fixture error'); });\n");
  commit(worktree(), 'crash.test.mjs', "throw new Error('fixture module crash');\n");
  const failing = land();
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

test("a local board, or one with no GitHub repo or git remote, branches from its own folder's local branch and lands there, never kickflip's clone", () => {
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
    const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: project });
    assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'main'));
    reset();
  }

  setOrch({});
  const none = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.deepEqual([none.code, none.err], [1, '/orch has no folder recorded for its session; rejoin it from its repo folder\n']);

  setOrch({ owner: { repo: project } });
  fs.rmSync(at('waves', 'w', 'agents'), { recursive: true });
  git(project, 'worktree', 'add', '--quiet', '-b', 'A1', worktree(), 'main');
  commit(worktree(), 'card.txt', 'card', 'A1: card');
  const landed = run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  assert.equal(landed.code, 0, landed.err);
  assert.match(landed.out, new RegExp(`main fast-forwarded to \\w+ in ${project}`));
  assert.equal(fs.readFileSync(path.join(project, 'card.txt'), 'utf8'), 'card');
});

test('a local board whose recorded branch is trunk branches from trunk and lands there, refusing while its folder is on another branch, naming trunk', () => {
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
  const started = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(started.code, 0, started.err);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'trunk'));
  commit(worktree(), 'card.txt', 'card', 'A1: card');

  git(project, 'switch', '--quiet', '-c', 'feature');
  const landTrunk = () => run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  const refused = landTrunk();
  assert.deepEqual([refused.code, refused.err], [1, `${project} is on feature, not trunk; switch it to trunk (git -C ${project} switch trunk) and land again\n`]);

  git(project, 'switch', '--quiet', 'trunk');
  commit(project, 'moved.txt', 'trunk moved');
  const moved = git(project, 'rev-parse', '--short', 'trunk');
  const landed = landTrunk();
  assert.equal(landed.code, 0, landed.err);
  const tip = git(project, 'rev-parse', '--short', 'trunk');
  assert.deepEqual(landed.out.trim().split('\n').slice(0, 3), [`rebased A1 onto trunk (${moved})`, 'tests passed: 0', `trunk fast-forwarded to ${tip} in ${project}`]);
  assert.equal(fs.readFileSync(path.join(project, 'card.txt'), 'utf8'), 'card');
  assert.equal(git(project, 'rev-parse', 'trunk~1'), git(project, 'rev-parse', moved));
});

test('land keeps a "#N: subject" commit through its rebase', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  git(worktree(), 'add', '-A');
  git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '-m', '#7: subject');
  commit(repo, 'shared/notes.md', 'b\n');
  const before = git(repo, 'rev-parse', 'main');
  const r = land();
  assert.equal(r.code, 0, r.err);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), '#7: subject');
  assert.equal(git(repo, 'rev-parse', 'main~1'), before);
});

test('land refuses a commit with an empty subject, naming it, and leaves main as it was', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '--allow-empty-message', '--cleanup=verbatim', '-m', '');
  const sha = git(worktree(), 'rev-parse', '--short', 'HEAD');
  const main = git(repo, 'rev-parse', 'main');
  const r = land();
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`empty subject \\(${sha}\\)`));
  assert.equal(git(repo, 'rev-parse', 'main'), main);
});

test('land rebases onto a moved main, fast-forwards main, and removes the worktree and branch; a repo other than the running kickflip clone restarts nothing', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'board/server.mjs', '2\n');
  commit(worktree(), 'hub/hub.mjs', "import { a } from '../shared/lib.mjs';\n// 2\n");
  commit(repo, 'shared/notes.md', 'b\n');
  const moved = git(repo, 'rev-parse', '--short', 'main');
  const r = land();
  assert.equal(r.code, 0, r.err);
  const main = git(repo, 'rev-parse', '--short', 'main');
  assert.deepEqual(r.out.trim().split('\n'), [
    `rebased A1 onto main (${moved})`, 'tests passed: 1', `main fast-forwarded to ${main} in ${repo}`,
    `worktree removed: ${worktree()}`, 'branch deleted: A1',
  ]);
  assert.equal(git(repo, 'rev-parse', 'main~2'), git(repo, 'rev-parse', moved));
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
    assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
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

test('land on --site needs --text, refuses before landing what closing would refuse, and closes the card as done once it lands', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n', 'A1: notes');
  const landOn = (...more) => run('board.mjs', ['land', 'w/A1', '--site', 'orch', ...more], undefined, {
    KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']),
  });
  assert.equal(landOn().code, 2);
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [question('q1', { topic: 'item:w/A1' })] });
  const main = git(repo, 'rev-parse', 'main');
  const open = landOn('--text', 'Checked on the phone.');
  assert.equal(open.code, 1);
  assert.match(open.err, /^land: w\/A1 has an open question q1 with no answer yet/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' } });
  const r = landOn('--text', 'Checked on the phone.');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.deepEqual(r.out.trim().split('\n').slice(-2), ['A1: landed and done', 'resolved: q1']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'done');
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Checked on the phone.');
  assert.ok(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).some((m) => m.kind === 'status' && m.phase === 'landing'), 'the finish itself sets the landing phase');
});

test('land --owner-step lands the code and leaves the card open on its owner step and its check; a blank step or a bad check is refused before landing', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n', 'A1: notes');
  const landOn = (...more) => run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked on the phone.', ...more], undefined, {
    KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']),
  });
  const main = git(repo, 'rev-parse', 'main');
  assert.deepEqual([landOn('--owner-step', ' ').code, landOn('--owner-step', ' ').err], [1, '--owner-step must be non-empty text\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  const badCheck = landOn('--owner-step', 'Tag the first release', '--check', 'tag nowhere v*');
  assert.deepEqual([badCheck.code, badCheck.err], [1, `--check tag <owner/repo> <pattern>: "nowhere" isn't a GitHub repo such as owner/name\n`]);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  const r = landOn('--owner-step', 'Tag the first release', '--check', 'tag o/r v*');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(r.out.trim().split('\n').at(-1), 'A1: landed; waits on the owner step "Tag the first release"');
  const item = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([item.lane, item.owner_step, item.owner_check.check], ['done', 'Tag the first release', 'tag o/r v*']);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Checked on the phone.');
});

test("builder done on a card whose PR link a reviewer has asks for the Updated decision, and queues Updated once done goes through", () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7 }] });
  const record = () => read(site('orch', 'data', 'pr-slack.json'))['o/r#7'];
  write(site('orch', 'data', 'pr-slack.json'), { 'o/r#7': { head: 'a', links: { Ann: { channel: 'D1', ts: '1.1', reactions: [] } }, replies: [] } });
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const bare = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it');
  assert.deepEqual([bare.code, bare.err], [1, 'a reviewer has w/A1\'s PR link: pass --updated "<what changed>" for its thread, or --updated none for a change only to comments, names, docs or tests\n']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, undefined);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it', '--updated', 'limits reset per key');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(record().replies, [{ id: 'updated-1', text: 'Updated: limits reset per key', to: { Ann: {} } }]);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const quiet = board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Wait for review', '--updated', 'none');
  assert.equal(quiet.code, 0, quiet.err);
  assert.equal(record().replies.length, 1);
});

test('builder done --owner-step records the step on the card, and refuses one on a card already closed, naming land', () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, ...extra }] });
  items({});
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag the first release');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out.trim(), 'A1: builder done; owner step "Tag the first release"');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, 'Tag the first release');
  items({ lane: 'done', closed_at: '2026-11-01T10:00:00Z' });
  const late = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it');
  assert.deepEqual([late.code, late.err], [1, 'w/A1 is already Done, so its ticket closed; an owner step goes on the command that finishes the card: land --owner-step, or builder done before the merge\n']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, undefined);
});

// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
test('builder done --check attaches a named check to the owner step, refusing one without the step or with bad arguments', () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, ...extra }] });
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  items({});
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const alone = board('builder', 'done', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.equal(alone.code, 2);
  assert.match(alone.err, /--check goes with --owner-step/);
  const shell = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag a release', '--check', 'sh -c "rm -rf ~"');
  assert.equal(shell.code, 1);
  assert.match(shell.err, /^--check has no check "sh"; it takes tag <owner\/repo> <pattern>/);
  assert.equal(item().owner_step, undefined);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag a release', '--check', 'npm  kickflip 0.3.*');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual([item().owner_step, item().owner_check.check], ['Tag a release', 'npm kickflip 0.3.*']);
  assert.ok(Date.parse(item().owner_check.since) <= Date.now());
});

test('item set --check changes or removes the check on a card waiting on its owner step, clearing a broken mark, and refuses a card with no step', () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'done', closed_at: '2026-11-01T10:00:00Z', ...extra }] });
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  items({});
  const none = board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.deepEqual([none.code, none.err], [1, `--check goes with an owner step, which w/A1 doesn't have: pass --owner-step "<the step>" with it on builder done or land\n`]);
  const since = '2026-11-04T10:00:00.000Z';
  items({ owner_step: 'Publish it', owner_check: { check: 'npm kickflip 0.3.*', since, broken: 'npm view failed: E404' } });
  const again = board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out.trim(), 'A1: check npm kickflip 0.3.*');
  assert.deepEqual(item().owner_check, { check: 'npm kickflip 0.3.*', since });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'tag o/r v0.3.*').code, 0);
  assert.equal(item().owner_check.check, 'tag o/r v0.3.*');
  assert.notEqual(item().owner_check.since, since);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--check', '').code, 0);
  assert.deepEqual([item().owner_step, item().owner_check], ['Publish it', undefined]);
});

test("land refuses while a builder record on the card has unverified judgment calls, naming builder verified, and lands once they're verified", () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'fix').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--agent', 'fix', 'Kept the old name').code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n');
  const main = git(repo, 'rev-parse', 'main');
  const refused = land();
  assert.deepEqual([refused.code, refused.err], [1, 'land: w/A1 has judgment calls nobody verified yet; check them with builder calls w/A1 --agent fix, then run builder verified w/A1 --agent fix\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(board('builder', 'verified', 'w/A1', '--agent', 'fix').code, 0);
  const r = land();
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
});

test('land skips tests inside .repos and node_modules at every depth', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  const ignored = "import test from 'node:test';\ntest('foreign test', () => { throw new Error('foreign suite ran'); });\n";
  for (const directory of ['.repos/owner/repo', 'node_modules/dependency', 'nested/.repos/owner/repo', 'nested/node_modules/dependency']) {
    write(path.join(worktree(), directory, 'foreign.test.mjs'), ignored);
  }
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '-m', 'foreign repos');
  const result = land();
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /tests passed: 1/);
  assert.equal(fs.existsSync(worktree()), false);
});

test('land refuses a rebase that conflicts, naming the files, and leaves the branch, worktree and main as they were', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n');
  commit(repo, 'shared/notes.md', 'main\n');
  const [main, head] = [git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD')];
  const r = land();
  assert.deepEqual([r.code, r.err], [1, `rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again\n`]);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD'), git(worktree(), 'status', '--porcelain')], [main, head, '']);
  assert.equal(fs.readFileSync(path.join(worktree(), 'shared', 'notes.md'), 'utf8'), 'branch\n');
  assert.deepEqual(restarts(), []);
});

test('builder done on a build that keeps a worktree finishes the card: it needs --text, lands it and closes the card and its record; a failed finish refuses with the reason and keeps the builder on', () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'broken.test.mjs', "import test from 'node:test';\ntest('broken', () => { throw new Error('nope'); });\n", 'A1: work');
  const main = git(repo, 'rev-parse', 'main');
  const bare = onOrch('builder', 'done', 'w/A1');
  assert.deepEqual([bare.code, bare.err], [1, 'builder done finishes w/A1: pass --text "<what you checked>", or --next "<what happens next>" to stop without finishing\n']);
  const failed = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^tests failed in .* \(1 failing\); nothing landed/);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), record().done, itemOf().lane], [main, undefined, undefined]);

  fs.rmSync(path.join(worktree(), 'broken.test.mjs'));
  git(worktree(), 'commit', '--quiet', '-am', 'A1: fixed');
  const r = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().lane, 'done');
  assert.equal(typeof record().done, 'string');
  assert.equal(threadOf().at(-1).text, 'Checked it.');
  assert.equal(fs.existsSync(worktree()), false);
});

test("builder done --next on a build stops it without finishing, an --agent helper's done only stops its own record, and the main build's done refuses while a helper is still open", () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  assert.equal(onOrch('builder', 'start', 'w/A1', '--agent', 'lint').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const main = git(repo, 'rev-parse', 'main');
  const busy = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.deepEqual([busy.code, busy.err], [1, 'builder done would finish w/A1 while agent lint is still open; run builder done w/A1 --agent lint first\n']);
  assert.equal(onOrch('builder', 'done', 'w/A1', '--agent', 'lint').code, 0);
  const stopped = onOrch('builder', 'done', 'w/A1', '--next', 'Check the build');
  assert.equal(stopped.code, 0, stopped.err);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), typeof record().done, itemOf().next], [main, 'string', 'Check the build']);
});

test("a finish on a local board pushes its branch to origin once it lands when the board's push switch is on; off, nothing is pushed, and a push that fails is said without undoing the land", () => {
  const repo = scratchRepo();
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two' }, { id: 'A3', title: 'Three' }] });
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  const finish = (id) => {
    assert.equal(onOrch('builder', 'start', `w/${id}`, '--kind', 'build').code, 0);
    commit(at('kickflip', 'worktrees', id), `${id}.txt`, 'built\n', `${id}: work`);
    const r = onOrch('builder', 'done', `w/${id}`, '--text', 'Checked it.');
    assert.equal(r.code, 0, r.err);
    return r;
  };
  const before = git(origin, 'rev-parse', 'main');
  assert.ok(!finish('A1').out.includes('origin'));
  assert.equal(git(origin, 'rev-parse', 'main'), before);

  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  assert.ok(finish('A2').out.includes('\npushed main to origin\n'));
  assert.equal(git(origin, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));

  git(repo, 'remote', 'set-url', 'origin', path.join(home, 'gone.git'));
  const failed = finish('A3');
  assert.match(failed.out, /\nlanded, but main didn't reach origin: .+; push it with git -C .+ push origin main\n/);
  assert.equal(itemOf('A3').lane, 'done');
  assert.match(threadOf('A3').at(-1).text, /^Landed, but main didn't reach origin: /);
});

test('builder verified on a handed-back build finishes the card in the same step, its note the closing line', () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  assert.equal(onOrch('builder', 'call', 'w/A1', 'Kept the old name').code, 0);
  const main = git(repo, 'rev-parse', 'main');
  assert.equal(onOrch('builder', 'done', 'w/A1').code, 0);
  assert.deepEqual([itemOf().lane, typeof record().handed_back, git(repo, 'rev-parse', 'main')], [undefined, 'string', main]);
  const r = onOrch('builder', 'verified', 'w/A1', '--note', 'The old name holds.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: judgment calls verified; landed and done\n'), r.out);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().lane, 'done');
  assert.equal(threadOf().at(-1).text, 'The old name holds.');
});

test("builder verified leaves a card handed back while one of its questions is open, and a finish that fails keeps the stamp and says why", () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n', 'A1: work');
  assert.equal(onOrch('builder', 'call', 'w/A1', 'Kept the old name').code, 0);
  assert.equal(onOrch('builder', 'done', 'w/A1').code, 0);
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [question('q1', { topic: 'item:w/A1' })] });
  const waits = onOrch('builder', 'verified', 'w/A1');
  assert.deepEqual([waits.code, waits.err], [0, '']);
  assert.equal(waits.out, "A1: judgment calls verified\nA1 finishes once the owner answers q1\n");
  assert.deepEqual([itemOf().lane, typeof record().handed_back, typeof record().verified.at], [undefined, 'string', 'string']);

  write(site('orch', 'data', 'owner.json'), { topics: [], items: [] });
  assert.equal(onOrch('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(onOrch('builder', 'call', 'w/A1', 'Kept the old colour').code, 0);
  assert.equal(onOrch('builder', 'done', 'w/A1').code, 0);
  commit(repo, 'shared/notes.md', 'main\n');
  const main = git(repo, 'rev-parse', 'main');
  const failed = onOrch('builder', 'verified', 'w/A1');
  assert.equal(failed.code, 1);
  assert.equal(failed.err, `judgment calls verified, but A1 didn't finish: rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again\n`);
  assert.deepEqual([itemOf().lane, typeof record().handed_back, git(repo, 'rev-parse', 'main'), onOrch('builder', 'calls', 'w/A1').out.includes('\nverified ')], ['progress', 'string', main, true]);
});

test('on a GitHub board, builder done sends the build for review: it pushes the branch, opens a draft PR, and the card moves to it with its record closed', () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { ...finishEnv, PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const main = git(origin, 'rev-parse', 'main');
  const r = b('builder', 'done', 'w/A1', '--text', 'Checked it on the phone.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: draft PR #100 opened\n'), r.out);
  assert.deepEqual([git(origin, 'rev-parse', 'A1'), git(origin, 'rev-parse', 'main')], [git(worktree(), 'rev-parse', 'HEAD'), main]);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr'), ['pr', 'create', '--draft', '--repo', 'owner/project', '--base', 'main', '--head', 'A1', '--title', 'A1: One', '--body', 'Checked it on the phone.']);
  assert.deepEqual([itemOf().prs, itemOf().lane, typeof record().done], [[{ number: 100 }], 'review', 'string']);
  assert.equal(threadOf().at(-1).text, 'Checked it on the phone.');
  assert.equal(fs.existsSync(worktree()), true);
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("on a GitHub board, builder done on a card whose PR is open force-pushes the rebased branch with a lease, keeps the PR, and records a rebase run's push", () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { ...finishEnv, PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  assert.equal(b('builder', 'done', 'w/A1', '--text', 'Checked it.').code, 0);
  const before = git(origin, 'rev-parse', 'A1');

  // main moves on; the board's rebase run (rebase_run, which the server sets) rebases the branch onto it.
  commit(origin, 'other.txt', 'main moved\n', 'main moved');
  const wave = read(at('waves', 'w', 'wave.json'));
  wave.items[0].rebase_run = { pr: 100, base: 'main', conflict: `${before.slice(0, 10)}@main`, at: new Date().toISOString() };
  write(at('waves', 'w', 'wave.json'), wave);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Rebase').code, 0);
  git(worktree(), 'fetch', '--quiet', 'origin');
  git(worktree(), 'rebase', '--quiet', 'origin/main');
  const rebased = git(worktree(), 'rev-parse', 'HEAD');

  // Someone else's push since the fetch: the lease refuses, and nothing changes on origin or the card.
  git(origin, 'branch', '-f', 'A1', 'main');
  const refused = b('builder', 'done', 'w/A1', '--text', 'Rebased onto main.');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /could not push A1 to origin/);
  assert.deepEqual([git(origin, 'rev-parse', 'A1'), itemOf().rebased, typeof itemOf().rebase_run], [git(origin, 'rev-parse', 'main'), undefined, 'object']);

  git(origin, 'branch', '-f', 'A1', before);
  const r = b('builder', 'done', 'w/A1', '--text', 'Rebased onto main.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: pushed A1 to PR #100\n'), r.out);
  assert.equal(git(origin, 'rev-parse', 'A1'), rebased);
  assert.equal(calls(ghDir).filter((a) => a[0] === 'pr' && a[1] === 'create').length, 1, 'the PR stays as it is');
  const item = itemOf();
  assert.deepEqual([item.prs, item.lane, item.rebase_run, typeof record().done], [[{ number: 100 }], 'review', undefined, 'string']);
  assert.deepEqual(item.rebased.map(({ at: _, ...r }) => r), [{ from: before, to: rebased, base: 'main', replayed: true }]);
  assert.equal(threadOf().at(-1).text, 'Rebased onto main.');

  // A run's hand-back keeps it through its lander; any other build on the card ends it, so its push isn't a rebase's.
  const again = read(at('waves', 'w', 'wave.json'));
  again.items[0].rebase_run = { pr: 100, base: 'main', conflict: 'x@main', at: new Date().toISOString() };
  write(at('waves', 'w', 'wave.json'), again);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander').code, 0);
  assert.equal(typeof itemOf().rebase_run, 'object');
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(itemOf().rebase_run, undefined);
});

test('on a plain git remote, builder done pushes the branch and the card waits on the merge', () => {
  const origin = remoteBoard((dir) => ({ remote: dir }));
  assert.equal(onOrch('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const r = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: pushed A1 for its merge\n'), r.out);
  assert.equal(git(origin, 'rev-parse', 'A1'), git(worktree(), 'rev-parse', 'HEAD'));
  assert.deepEqual([itemOf().pushed.branch, typeof record().done], ['A1', 'string']);
  // docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md: the first arrival in review is kept, however often the push is set again.
  const arrived = itemOf().review_since;
  assert.equal(typeof arrived, 'string');
  assert.equal(onOrch('item', 'set', 'w/A1', '--pushed', 'A1').code, 0);
  assert.equal(itemOf().review_since, arrived);
});

test("with Auto-merge off, builder done on a local board verifies the build and holds it for the owner's Merge; merge after the tap rebases onto main as it is, lands it, closes the card and pushes main", () => {
  const repo = scratchRepo();
  heldBoard();
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const main = git(repo, 'rev-parse', 'main');
  const held = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(held.code, 0, held.err);
  assert.ok(held.out.includes('\nA1: verified; waits for your Merge\n'), held.out);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), itemOf().lane, itemOf().merge_ready.branch, typeof record().done], [main, 'review', 'A1', 'string']);
  assert.equal(threadOf().at(-1).text, 'Checked it.');
  assert.equal(fs.existsSync(worktree()), true);

  const untapped = onOrch('merge', 'w/A1');
  assert.deepEqual([untapped.code, untapped.err], [1, "w/A1 isn't waiting on a Merge tap\n"]);
  commit(repo, 'later.txt', 'main moved\n');
  tapMerge();
  const merged = onOrch('merge', 'w/A1');
  assert.equal(merged.code, 0, merged.err);
  assert.ok(merged.out.includes('\nA1: landed and done\n'), merged.out);
  assert.ok(merged.out.includes('\npushed main to origin\n'), merged.out);
  assert.equal(git(repo, 'show', 'main:work.txt'), 'built');
  assert.equal(git(repo, 'show', 'main:later.txt'), 'main moved');
  assert.equal(git(origin, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
  assert.deepEqual([itemOf().lane, itemOf().merge_ready], ['done', undefined]);
  assert.equal(threadOf().at(-1).text, 'Landed on main on your Merge.');
  assert.equal(fs.existsSync(worktree()), false);
});

// docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md
test('a Merge tap on a held build whose tested commit is still on top of main lands it without running the suite again; a main that moved is tested again', () => {
  const repo = scratchRepo();
  heldBoard();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const held = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.ok(held.out.includes('tests passed: 1'), held.out);
  tapMerge();
  const merged = onOrch('merge', 'w/A1');
  assert.equal(merged.code, 0, merged.err);
  assert.ok(merged.out.includes('A1 was tested on main as it is now; not testing it again'), merged.out);
  assert.equal(merged.out.includes('tests passed'), false, merged.out);
  assert.equal(git(repo, 'show', 'main:work.txt'), 'built');
  assert.equal(git(repo, 'for-each-ref', 'refs/kickflip'), '');

  assert.equal(onOrch('builder', 'start', 'w/ENG-1', '--worktree', '--repo', repo).code, 0);
  const second = at('kickflip', 'worktrees', 'ENG-1');
  commit(second, 'more.txt', 'more\n', 'ENG-1: work');
  assert.equal(onOrch('builder', 'done', 'w/ENG-1', '--text', 'Checked it.').code, 0);
  commit(repo, 'later.txt', 'main moved\n');
  tapMerge('ENG-1');
  const retested = onOrch('merge', 'w/ENG-1');
  assert.equal(retested.code, 0, retested.err);
  assert.ok(retested.out.includes('rebased ENG-1 onto main'), retested.out);
  assert.ok(retested.out.includes('tests passed: 1'), retested.out);
});

test('a tapped Merge whose rebase conflicts launches a headless lander, and the lander finishes it onto main with no second tap', async () => {
  const repo = scratchRepo();
  heldBoard();
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const env = { ...finishEnv, KICKFLIP_CLAUDE: fake };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n', 'A1: work');
  assert.equal(b('builder', 'done', 'w/A1', '--text', 'Checked it.').code, 0);
  commit(repo, 'shared/notes.md', 'main\n');
  const main = git(repo, 'rev-parse', 'main');
  tapMerge();
  const failed = b('merge', 'w/A1');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^rebasing A1 onto main conflicts in shared\/notes\.md/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.deepEqual(threadOf().slice(-2).map((m) => m.text), [
    `Not merged yet: rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again. A lander fixes it and lands it.`,
    `Lander launched on Claude Opus in ${worktree()}.`,
  ]);
  await until(() => fs.existsSync(seen), 'the lander runs');
  assert.match(fs.readFileSync(seen, 'utf8'), /You are the headless lander for card A1/);

  // The lander resolves the conflict and finishes; the tap was the go.
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander').code, 0);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  commit(worktree(), 'work.txt', 'built on main\n', 'A1: work, kept main');
  const landed = b('builder', 'done', 'w/A1', '--text', 'Resolved it.');
  assert.equal(landed.code, 0, landed.err);
  assert.ok(landed.out.includes('\nA1: landed and done\n'), landed.out);
  assert.equal(itemOf().lane, 'done');
});

test("a tapped Merge refused for a reason no lander fixes says why in the thread and leaves the card waiting for its Merge", () => {
  const repo = scratchRepo();
  heldBoard();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  assert.equal(onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.').code, 0);
  git(repo, 'switch', '--quiet', '-c', 'elsewhere');
  tapMerge();
  const failed = onOrch('merge', 'w/A1');
  assert.equal(failed.code, 1);
  assert.equal(threadOf().at(-1).text, `Not merged: ${repo} is on elsewhere, not main; switch it to main (git -C ${repo} switch main) and land again. Tap Merge again.`);
  assert.deepEqual([itemOf().lane, itemOf().merge_ready.branch], ['review', 'A1']);
});

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md
test("the hub board's settings default to Merge, prs off, until its owner picks a PR mode; any other board defaults to PRs on", () => {
  scratchRepo();
  const manifestFile = at('kickflip', 'manifest.json');
  const setOrch = (fields) => {
    const manifest = read(manifestFile);
    manifest.sites.orch = { dir: manifest.sites.orch.dir, port: 1, cmd: manifest.sites.orch.cmd, github: 'owner/project', branch: 'main', local: true, ...fields };
    write(manifestFile, manifest);
  };
  const prs = () => JSON.parse(board('--site', 'orch', 'settings').out).prs;
  setOrch({ hub: true });
  assert.equal(prs(), false);
  setOrch({});
  assert.equal(prs(), true);
  setOrch({ hub: true });
  const cfgFile = site('orch', 'board.json');
  write(cfgFile, { ...read(cfgFile), prs: true });
  assert.equal(prs(), true);
});

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md: what decides whether the board's cards
// show its reviewers.
test('the hub board opens PRs, and so shows reviewers, only on Draft PR or Ready PR; no other local board ever does', () => {
  const hub = { github: 'owner/project', local: true, hub: true };
  const local = { github: 'owner/project', local: true };
  assert.deepEqual([{}, { prs: true }, { prs: true, skip_draft: true }].map((cfg) => opensPRs(hub, settingsOf(cfg, hub))), [false, true, true]);
  assert.equal(opensPRs(local, settingsOf({ prs: true }, local)), false);
});

// The hub board builds in its folder, a clone of origin whose main holds a commit origin doesn't have.
const hubBoard = () => {
  const origin = remoteBoard(() => ({ github: 'owner/project', local: true, hub: true }));
  const folder = path.join(home, 'clone');
  commit(folder, 'local.txt', 'only in the folder\n', 'local work');
  return { origin, folder };
};

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md
test('on Merge, a hub card branches from its folder\'s main and lands there, opening no PR and pushing nothing without Push main', () => {
  const ghDir = path.join(home, 'gh');
  const { origin, folder } = hubBoard();
  const env = { ...finishEnv, PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  const main = git(origin, 'rev-parse', 'main');
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(fs.existsSync(path.join(worktree(), 'local.txt')), true);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const r = b('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.equal(git(folder, 'show', 'main:work.txt'), 'built');
  assert.equal(git(origin, 'rev-parse', 'main'), main);
  assert.deepEqual([itemOf().lane, itemOf().prs, calls(ghDir).filter((a) => a[0] === 'pr')], ['done', undefined, []]);
});

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md
test("on Draft PR or Ready PR, a hub card branches from origin's main, and its finish pushes the branch and opens a draft PR holding only the card's commits, leaving main as it was", () => {
  const ghDir = path.join(home, 'gh');
  const { origin, folder } = hubBoard();
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two' }] });
  const env = { ...finishEnv, PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  const folderMain = git(folder, 'rev-parse', 'main');
  const originMain = git(origin, 'rev-parse', 'main');
  const finish = (id) => {
    const tree = at('kickflip', 'worktrees', id);
    assert.equal(b('builder', 'start', `w/${id}`, '--kind', 'build').code, 0);
    assert.equal(fs.existsSync(path.join(tree, 'local.txt')), false);
    commit(tree, `${id}.txt`, 'built\n', `${id}: work`);
    const r = b('builder', 'done', `w/${id}`, '--text', `Checked ${id}.`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`\\n${id}: draft PR #\\d+ opened\\n`));
    assert.equal(git(origin, 'rev-parse', id), git(tree, 'rev-parse', 'HEAD'));
    assert.equal(git(origin, 'rev-list', '--count', `main..${id}`), '1');
    assert.deepEqual(calls(ghDir).filter((a) => a[0] === 'pr').at(-1), ['pr', 'create', '--draft', '--repo', 'owner/project', '--base', 'main', '--head', id, '--title', `${id}: ${itemOf(id).title}`, '--body', `Checked ${id}.`]);
    assert.deepEqual([itemOf(id).lane, itemOf(id).prs?.length], ['review', 1]);
  };
  assert.deepEqual(b('settings', 'set', 'prs', 'on'), { code: 0, out: 'prs on\n', err: '' });
  finish('A1');
  // Ready PR opens the same draft; the hub's GitHub check marks it ready once its CI passes.
  assert.equal(b('settings', 'set', 'skip-draft', 'on').code, 0);
  finish('A2');
  assert.deepEqual([git(folder, 'rev-parse', 'main'), git(origin, 'rev-parse', 'main')], [folderMain, originMain]);
});

test('PRs off on a GitHub board needs Push main granted; then a finish lands in the shared clone on main as origin has it, and pushes main', () => {
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  git(origin, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  const clone = path.join(home, 'clone');
  const refused = onOrch('settings', 'set', 'prs', 'off');
  assert.deepEqual([refused.code, refused.err], [1, 'Merge lands each card on main and pushes it, so turn on Push main after a land first\n']);
  write(path.join(clone, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(clone, '.git', 'info', 'exclude'), '.claude\n');
  assert.deepEqual(onOrch('settings', 'set', 'prs', 'off'), { code: 0, out: 'prs off\n', err: '' });
  assert.equal(onOrch('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  commit(origin, 'later.txt', 'origin moved\n');
  const r = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.ok(r.out.includes('\npushed main to origin\n'), r.out);
  assert.equal(git(origin, 'show', 'main:work.txt'), 'built');
  assert.equal(git(origin, 'show', 'main:later.txt'), 'origin moved');
  assert.deepEqual([itemOf().lane, itemOf().prs], ['done', undefined]);
});
