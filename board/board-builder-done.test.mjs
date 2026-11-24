import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { until, untilTestEnds } from '../shared/test-helpers.mjs';
import { opensPRs, settingsOf } from './store.mjs';
import { SUMMARY_HINT } from './domain.mjs';
import { fakeGh, writeLimit, writeOpen, calls } from '../shared/fake-gh.mjs';
import { clock } from '../hub/schedule.mjs';
import { boardWith, bin, home, at, site, write, read, run, board, wave, question, git, commit, scratchRepo, heldBoard, boardWorktree as worktree, land, branches, onOrch, launched, record, itemOf, threadOf, remoteBoard, tapMerge, onHome } from './board-fixture.mjs';


test('builder done on a build that keeps a worktree finishes the card: it needs --text, lands it and closes the card and its record; a failed finish refuses with the reason and keeps the builder on', async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'broken.test.mjs', "import test from 'node:test';\ntest('broken', () => { throw new Error('nope'); });\n", 'feat: work\n\nRefs: A1');
  const main = git(repo, 'rev-parse', 'main');
  const bare = await onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.deepEqual([bare.code, bare.err], [1, `builder done ends w/A1's build: pass --summary "${SUMMARY_HINT}"\n`]);
  const untexted = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.');
  assert.deepEqual([untexted.code, untexted.err], [1, 'builder done finishes w/A1: pass --text "<what you checked>", or --next "<what happens next>" to stop without finishing\n']);
  const failed = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^tests failed in .* \(1 failing\); nothing landed/);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), record().done, itemOf().lane], [main, undefined, undefined]);

  write(path.join(worktree(), 'broken.test.mjs'), "import test from 'node:test';\ntest('fixed', () => {});\n");
  git(worktree(), 'commit', '--quiet', '-am', 'fix: fixed\n\nRefs: A1');
  const r = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built the work; left the docs out.', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.equal(record().summary, 'Built the work; left the docs out.');
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().lane, 'done');
  assert.equal(typeof record().done, 'string');
  assert.equal(threadOf().at(-1).text, 'Checked it.');
  assert.equal(fs.existsSync(worktree()), false);
});

// docs/adr/2026-11-16-0830-a-builder-hands-back-with-a-summary-message.md
test("a build that hands back its judgment calls needs a summary too, which its record keeps for the thread; a helper's done takes none", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--agent', 'lint')).code, 0);
  const helper = await onOrch('builder', 'done', 'w/A1', '--agent', 'lint', '--summary', 'Linted.');
  assert.match(helper.err, /--summary goes on the build's own done/);
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--agent', 'lint')).code, 0);
  assert.equal((await onOrch('builder', 'call', 'w/A1', 'Kept the old name')).code, 0);
  const bare = await onOrch('builder', 'done', 'w/A1');
  assert.deepEqual([bare.code, bare.err], [1, `builder done ends w/A1's build: pass --summary "${SUMMARY_HINT}"\n`]);
  assert.equal(record().done, undefined);
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--summary', '  ')).code, 1, 'a blank summary is none');
  const r = await onOrch('builder', 'done', 'w/A1', '--summary', 'Renamed the footer.\nLeft the header as it was.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^handed back: /m);
  assert.deepEqual([record().summary, typeof record().done], ['Renamed the footer.\nLeft the header as it was.', 'string']);
});

test("builder done --next on a build stops it without finishing, an --agent helper's done only stops its own record, and the main build's done refuses while a helper is still open", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--agent', 'lint')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const main = git(repo, 'rev-parse', 'main');
  const busy = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.deepEqual([busy.code, busy.err], [1, 'builder done would finish w/A1 while agent lint is still open; run builder done w/A1 --agent lint first\n']);
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--agent', 'lint')).code, 0);
  const stopped = await onOrch('builder', 'done', 'w/A1', '--next', 'Check the build');
  assert.equal(stopped.code, 0, stopped.err);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), typeof record().done, itemOf().next], [main, 'string', 'Check the build']);
});

// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md: a build's done refuses while a
// process it started runs detached in its worktree, naming it, and goes on once it ends. Orphans go to launchd, pid 1,
// on a Mac; elsewhere a subreaper may take them.
test("builder done refuses while a process the build left detached in its worktree still runs, naming it, and goes on once it's stopped", { skip: process.platform !== 'darwin' }, async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  // The shell exits at once, leaving its child to launchd; the child ends with this test at the latest. The child keeps
  // the shell's stdout, so the pipe's end is the child's.
  const sh = spawn('sh', ['-c', 'node -e "$0" & echo $!', untilTestEnds()], { cwd: worktree(), stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = once(sh.stdout, 'end');
  const exited = once(sh, 'exit');
  const [pid] = await once(sh.stdout, 'data');
  await exited;
  const left = Number(String(pid).trim());
  assert.ok(left > 0);
  const refused = await onOrch('builder', 'done', 'w/A1', '--next', 'Check the build');
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`^builder done refuses while w/A1's build leaves processes running detached: ${left} node -e`));
  assert.match(refused.err, new RegExp(`Stop them \\(kill ${left}\\) and run builder done again\\.\\n$`));
  assert.equal(record().done, undefined);
  process.kill(left);
  await ended;
  const stopped = await onOrch('builder', 'done', 'w/A1', '--next', 'Check the build');
  assert.equal(stopped.code, 0, stopped.err);
});

test("a finish on a local board pushes its branch to origin once it lands when the board's push switch is on; off, nothing is pushed, and a push that fails is said without undoing the land", async () => {
  const repo = scratchRepo();
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'feat: one' }, { id: 'A2', title: 'feat: two' }, { id: 'A3', title: 'feat: three' }] });
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  const finish = async (id) => {
    launched('orch', `w/${id}`);
    assert.equal((await onOrch('builder', 'start', `w/${id}`, '--kind', 'build')).code, 0);
    commit(at('kickflip', 'worktrees', 'orch', id), `${id}.txt`, 'built\n', `feat: work\n\nRefs: ${id}`);
    const r = await onOrch('builder', 'done', `w/${id}`, '--summary', 'Built it.', '--text', 'Checked it.');
    assert.equal(r.code, 0, r.err);
    return r;
  };
  const before = git(origin, 'rev-parse', 'main');
  assert.ok(!(await finish('A1')).out.includes('origin'));
  assert.equal(git(origin, 'rev-parse', 'main'), before);

  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  assert.ok((await finish('A2')).out.includes('\npushed main to origin\n'));
  assert.equal(git(origin, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));

  git(repo, 'remote', 'set-url', 'origin', path.join(home, 'gone.git'));
  const failed = await finish('A3');
  assert.match(failed.out, /\nlanded, but main didn't reach origin: .+; push it with git -C .+ push origin main\n/);
  assert.equal(itemOf('A3').lane, 'done');
  assert.match(threadOf('A3').at(-1).text, /^Landed, but main didn't reach origin: /);
});

test('builder verified on a handed-back build finishes the card in the same step, its note the closing line', async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await onOrch('builder', 'call', 'w/A1', 'Kept the old name')).code, 0);
  const main = git(repo, 'rev-parse', 'main');
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.')).code, 0);
  assert.deepEqual([itemOf().lane, typeof record().handed_back, git(repo, 'rev-parse', 'main')], [undefined, 'string', main]);
  const r = await onOrch('builder', 'verified', 'w/A1', '--note', 'The old name holds.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: judgment calls verified; landed and done\n'), r.out);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().lane, 'done');
  assert.equal(threadOf().at(-1).text, 'The old name holds.');
});

test("builder verified leaves a card handed back while one of its questions is open, and a finish that fails keeps the stamp and says why", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n', 'feat: work\n\nRefs: A1');
  assert.equal((await onOrch('builder', 'call', 'w/A1', 'Kept the old name')).code, 0);
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.')).code, 0);
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [question('q1', { topic: 'item:w/A1' })] });
  const waits = await onOrch('builder', 'verified', 'w/A1');
  assert.deepEqual([waits.code, waits.err], [0, '']);
  assert.equal(waits.out, "A1: judgment calls verified\nA1 finishes once the owner answers q1\n");
  assert.deepEqual([itemOf().lane, typeof record().handed_back, typeof record().verified.at], [undefined, 'string', 'string']);

  write(site('orch', 'data', 'owner.json'), { topics: [], items: [] });
  launched('orch', 'w/A1');
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal((await onOrch('builder', 'call', 'w/A1', 'Kept the old colour')).code, 0);
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.')).code, 0);
  commit(repo, 'shared/notes.md', 'main\n');
  const main = git(repo, 'rev-parse', 'main');
  const failed = await onOrch('builder', 'verified', 'w/A1');
  assert.equal(failed.code, 1);
  assert.equal(failed.err, `judgment calls verified, but A1 didn't finish: rebasing me/orch/a1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again\n`);
  assert.deepEqual([itemOf().lane, typeof record().handed_back, git(repo, 'rev-parse', 'main'), (await onOrch('builder', 'calls', 'w/A1')).out.includes('\nverified ')], ['progress', 'string', main, true]);
});

test('on a GitHub board, builder done sends the build for review: it pushes the branch, opens a draft PR, and the card moves to it with its record closed', async () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const main = git(origin, 'rev-parse', 'main');
  // docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md: the builder titles the
  // PR with a Conventional subject, checked before anything is pushed.
  const bad = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it on the phone.', '--title', 'A1: One');
  assert.deepEqual([bad.code, bad.err], [1, `--title "A1: One" isn't "<type>(<scope>): <summary>" with the type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert and a lowercase scope or a comma list of them; pass --title "<type>(<scope>): <summary>", at most 100 characters\n`]);
  assert.equal(git(origin, 'branch', '--list', 'me/orch/a1'), '');
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it on the phone.', '--title', 'feat(board): the work, as one PR');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: draft PR #100 opened\n'), r.out);
  assert.deepEqual([git(origin, 'rev-parse', 'me/orch/a1'), git(origin, 'rev-parse', 'main')], [git(worktree(), 'rev-parse', 'HEAD'), main]);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr' && a[1] === 'create'), ['pr', 'create', '--draft', '--repo', 'owner/project', '--base', 'main', '--head', 'me/orch/a1', '--title', 'feat(board): the work, as one PR', '--body', 'Checked it on the phone.']);
  assert.deepEqual([itemOf().prs, itemOf().lane, typeof record().done], [[{ number: 100 }], 'review', 'string']);
  assert.equal(threadOf().at(-1).text, 'Checked it on the phone.');
  assert.equal(fs.existsSync(worktree()), true);
});

// docs/adr/2026-11-24-0300-a-builder-writes-its-prs-body-by-the-repos-pr-guide.md
test("builder done --body-file is the draft PR's body, apart from --text, the thread's line; on a card whose PR is open it replaces that PR's body", async () => {
  const ghDir = path.join(home, 'gh');
  remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  launched('orch', 'w/A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const body = path.join(home, 'pr-body.md');
  fs.writeFileSync(body, '');
  const empty = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--body-file', body);
  assert.deepEqual([empty.code, empty.err], [1, `--body-file ${body} is empty: write the PR's body there\n`]);
  const text = `## Summary\n\n${'A long line of the body. '.repeat(100)}\n\n## Verification\n\nRan it.\n`;
  fs.writeFileSync(body, text);
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--body-file', body, '--title', 'feat(board): the work');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr' && a[1] === 'create').slice(9), ['--title', 'feat(board): the work', '--body', text]);
  assert.equal(threadOf().at(-1).text, 'Checked it.');

  // A later build on the card pushes to its open PR; its --body-file replaces the PR's body, and none keeps it.
  commit(worktree(), 'more.txt', 'more\n', 'fix: more\n\nRefs: A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  fs.writeFileSync(body, '## Summary\n\nThe work, fixed.\n');
  const again = await b('builder', 'done', 'w/A1', '--summary', 'Fixed it.', '--text', 'Checked the fix.', '--body-file', body);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(calls(ghDir).filter((a) => a[0] === 'pr' && a[1] === 'edit'), [['pr', 'edit', '100', '--repo', 'owner/project', '--body', '## Summary\n\nThe work, fixed.\n']]);
  commit(worktree(), 'last.txt', 'last\n', 'fix: last\n\nRefs: A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal((await b('builder', 'done', 'w/A1', '--summary', 'Again.', '--text', 'Checked.')).code, 0);
  assert.equal(calls(ghDir).filter((a) => a[0] === 'pr' && a[1] === 'edit').length, 1, 'a done with no --body-file leaves the body');
});

test("a handed-back build keeps its --body-file for builder verified's PR, and verified's own --body-file replaces it", async () => {
  const ghDir = path.join(home, 'gh');
  remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  launched('orch', 'w/A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await b('builder', 'call', 'w/A1', 'Kept the old colour')).code, 0);
  const body = path.join(home, 'pr-body.md');
  fs.writeFileSync(body, "## Summary\n\nThe builder's body.\n");
  const handed = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--body-file', body);
  assert.equal(handed.code, 0, handed.err);
  assert.equal(calls(ghDir).some((a) => a[0] === 'pr' && a[1] === 'create'), false);
  fs.rmSync(body);
  const r = await b('builder', 'verified', 'w/A1', '--note', 'Calls hold.', '--title', 'feat(board): the work');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr' && a[1] === 'create').slice(11), ['--body', "## Summary\n\nThe builder's body.\n"]);
  assert.equal(threadOf().at(-1).text, 'Calls hold.');
});

test("builder verified --body-file replaces the handed-back build's body", async () => {
  const ghDir = path.join(home, 'gh');
  remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  launched('orch', 'w/A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await b('builder', 'call', 'w/A1', 'Kept the old colour')).code, 0);
  const body = path.join(home, 'pr-body.md');
  fs.writeFileSync(body, "## Summary\n\nThe builder's body.\n");
  assert.equal((await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--body-file', body)).code, 0);
  fs.writeFileSync(body, "## Summary\n\nThe orchestrator's body.\n");
  const r = await b('builder', 'verified', 'w/A1', '--title', 'feat(board): the work', '--body-file', body);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr' && a[1] === 'create').slice(11), ['--body', "## Summary\n\nThe orchestrator's body.\n"]);
});

// docs/adr/2026-11-24-0100-a-block-holds-every-transition-and-its-end-moves-the-card-or-opens-a-wait.md
test('on a GitHub board, a block holds the PR: builder done opens none while the card is blocked', async () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  launched('orch', 'w/A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await b('item', 'set', 'w/A1', '--blocked-until', 'the API ships')).code, 0);
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--title', 'feat(board): the work');
  assert.equal(r.code, 1);
  assert.match(r.err, /A1 is blocked until the API ships, so its PR waits; it opens once nothing blocks it/);
  assert.equal(calls(ghDir).some((a) => a[0] === 'pr' && a[1] === 'create'), false);
  assert.equal(git(origin, 'branch', '--list', 'me/orch/a1'), '');
  assert.equal(itemOf().prs, undefined);
});

// docs/adr/2026-11-21-2333-a-task-can-keep-its-own-pr-base.md
test("a task's own base (item set --base) is where its builder branches from on origin and what its draft PR targets; --base \"\" clears it", async () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  git(origin, 'checkout', '--quiet', '-b', 'agent-main');
  commit(origin, 'agent.txt', 'agent code\n', 'agent base');
  const agentTip = git(origin, 'rev-parse', 'agent-main');
  git(origin, 'checkout', '--quiet', 'main');
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  launched('orch', 'w/A1');
  const bad = await b('item', 'set', 'w/A1', '--base', 'not a branch');
  assert.deepEqual([bad.code, bad.err], [1, '--base takes the name of the branch its PR targets\n']);
  const set = await b('item', 'set', 'w/A1', '--base', 'agent-main');
  assert.deepEqual([set.code, set.out], [0, 'A1: base agent-main\n'], set.err);
  assert.equal(itemOf().base, 'agent-main');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal(git(worktree(), 'merge-base', 'HEAD', 'refs/remotes/origin/agent-main'), agentTip);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--title', 'feat(board): the agent work');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr' && a[1] === 'create').slice(5, 7), ['--base', 'agent-main']);
  const cleared = await b('item', 'set', 'w/A1', '--base', '');
  assert.deepEqual([cleared.code, cleared.out, itemOf().base], [0, "A1: base cleared, the board's\n", undefined], cleared.err);
});

test('--base is refused on a board that lands in its own folder, where no PR opens', async () => {
  const r = await onOrch('item', 'set', 'w/A1', '--base', 'agent-main');
  assert.deepEqual([r.code, r.err], [1, "--base is for a board whose finish pushes its task's branch (a PR or a remote); this board lands in its own folder\n"]);
  assert.equal(itemOf().base, undefined);
});

test('a finish on a card with no PR recorded moves it to the open PR GitHub already has from its branch, whatever that PR targets, and opens none', async () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  launched('orch', 'w/A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  writeOpen(ghDir, 'owner/project', [{ number: 7, headRefName: 'me/orch/a1', isCrossRepository: false }]);
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.', '--title', 'feat(board): the work');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: pushed me/orch/a1 to PR #7\n'), r.out);
  assert.equal(calls(ghDir).filter((a) => a[0] === 'pr' && a[1] === 'create').length, 0);
  assert.equal(git(origin, 'rev-parse', 'me/orch/a1'), git(worktree(), 'rev-parse', 'HEAD'));
  assert.deepEqual([itemOf().prs, itemOf().lane], [[{ number: 7 }], 'review']);
});

// docs/adr/2026-11-19-1600-a-tasks-pr-is-commented-on-its-ticket.md
test("opening a card's draft PR comments it on the card's GitHub ticket once, the PR title linked, and a push to the open PR comments nothing", async () => {
  const ghDir = path.join(home, 'gh');
  remoteBoard(() => ({ github: 'owner/project' }));
  const { saveBoardSettings } = await import('./store.mjs');
  await saveBoardSettings(site('orch'), { tickets: { source: 'github' } });
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: wave().items.map((i) => (i.id === 'A1' ? { ...i, ticket: '#7' } : i)) });
  launched('orch', 'w/A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked.', '--title', 'feat(board): the work, as one PR');
  assert.equal(r.code, 0, r.err);
  const comment = ['issue', 'comment', '7', '--repo', 'owner/project', '--body', 'PR opened: [feat(board): the work, as one PR](https://github.com/owner/project/pull/100)'];
  assert.deepEqual(calls(ghDir).filter((a) => a[1] === 'comment'), [comment]);
  assert.deepEqual(threadOf().filter((m) => m.line === 'ticket-commented').map((m) => [m.line, m.text]), [['ticket-commented', 'Commented on #7.']]);
  commit(worktree(), 'more.txt', 'more\n', 'feat: more\n\nRefs: A1');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal((await b('builder', 'done', 'w/A1', '--summary', 'Again.', '--text', 'Checked.')).code, 0);
  assert.equal(calls(ghDir).filter((a) => a[1] === 'comment').length, 1);
});

// docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md
test("while GitHub's limit holds, builder done pushes the branch but opens no PR, and says so with the reset time in the card's thread", async () => {
  const ghDir = path.join(home, 'gh');
  remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'fix: the first commit\n\nRefs: A1');
  commit(worktree(), 'more.txt', 'more\n', 'test: the second\n\nRefs: A1');
  const reset = new Date(Math.floor(Date.now() / 1000 + 3600) * 1000);
  writeLimit(ghDir, { graphql: reset.toISOString() });
  const words = `GitHub rate limited, resets at ${clock(reset)}`;
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`could not open a draft PR for me/orch/a1: ${words}`), r.err);
  assert.equal(itemOf().prs, undefined);
  assert.deepEqual([threadOf().at(-1).line, threadOf().at(-1).text], ['gh-limited', `No PR opened: ${words}.`]);
  fs.rmSync(path.join(ghDir, 'limit.json'));
  fs.rmSync(path.join(home, '.claude', 'kickflip', 'gh-limit.json'));
  const again = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(again.code, 0, again.err);
  // The limited open-PR lookup put the limit on the gate, which refused the create before gh ran.
  assert.ok(again.out.includes('\nA1: draft PR #100 opened\n'), again.out);
  // With no --title, the PR takes the card's title, not a commit subject.
  assert.deepEqual(calls(ghDir).filter((a) => a[0] === 'pr' && a[1] === 'create').at(-1).slice(9, 11), ['--title', 'feat: one']);
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("on a GitHub board, builder done on a card whose PR is open force-pushes the rebased branch with a lease, keeps the PR, and records a rebase run's push", async () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.')).code, 0);
  const before = git(origin, 'rev-parse', 'me/orch/a1');

  // main moves on; the board's rebase run (rebase_run, which the server sets) rebases the branch onto it.
  commit(origin, 'other.txt', 'main moved\n', 'main moved');
  const wave = read(at('waves', 'w', 'wave.json'));
  wave.items[0].rebase_run = { pr: 100, base: 'main', conflict: `${before.slice(0, 10)}@main`, at: new Date().toISOString() };
  write(at('waves', 'w', 'wave.json'), wave);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Rebase')).code, 0);
  git(worktree(), 'fetch', '--quiet', 'origin');
  git(worktree(), 'rebase', '--quiet', 'origin/main');
  const rebased = git(worktree(), 'rev-parse', 'HEAD');

  // Someone else's push since the fetch: the lease refuses, and nothing changes on origin or the card.
  git(origin, 'branch', '-f', 'me/orch/a1', 'main');
  const refused = await b('builder', 'done', 'w/A1', '--text', 'Rebased onto main.');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /could not push me\/orch\/a1 to origin/);
  assert.deepEqual([git(origin, 'rev-parse', 'me/orch/a1'), itemOf().rebased, typeof itemOf().rebase_run], [git(origin, 'rev-parse', 'main'), undefined, 'object']);

  git(origin, 'branch', '-f', 'me/orch/a1', before);
  const r = await b('builder', 'done', 'w/A1', '--text', 'Rebased onto main.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: pushed me/orch/a1 to PR #100\n'), r.out);
  assert.equal(git(origin, 'rev-parse', 'me/orch/a1'), rebased);
  assert.equal(calls(ghDir).filter((a) => a[0] === 'pr' && a[1] === 'create').length, 1, 'the PR stays as it is');
  const item = itemOf();
  assert.deepEqual([item.prs, item.lane, item.rebase_run, typeof record().done], [[{ number: 100 }], 'review', undefined, 'string']);
  assert.deepEqual(item.rebased.map(({ at: _, ...r }) => r), [{ from: before, to: rebased, base: 'main', replayed: true }]);
  assert.equal(threadOf().at(-1).text, 'Rebased onto main.');

  // A run's hand-back keeps it through its lander; any other build on the card ends it, so its push isn't a rebase's.
  const again = read(at('waves', 'w', 'wave.json'));
  again.items[0].rebase_run = { pr: 100, base: 'main', conflict: 'x@main', at: new Date().toISOString() };
  write(at('waves', 'w', 'wave.json'), again);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander')).code, 0);
  assert.equal(typeof itemOf().rebase_run, 'object');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal(itemOf().rebase_run, undefined);
});

test('on a plain git remote, builder done pushes the branch and the card waits on the merge', async () => {
  const origin = remoteBoard((dir) => ({ remote: dir }));
  launched('orch', 'w/A1');
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const r = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: pushed me/orch/a1 for its merge\n'), r.out);
  assert.equal(git(origin, 'rev-parse', 'me/orch/a1'), git(worktree(), 'rev-parse', 'HEAD'));
  assert.deepEqual([itemOf().pushed.branch, typeof record().done], ['me/orch/a1', 'string']);
  // docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md: the first arrival in review is kept, however often the push is set again.
  const arrived = itemOf().review_since;
  assert.equal(typeof arrived, 'string');
  assert.equal((await onOrch('item', 'set', 'w/A1', '--pushed', 'me/orch/a1')).code, 0);
  assert.equal(itemOf().review_since, arrived);
});

test("with Auto-merge off, builder done on a local board verifies the build and holds it for the owner's Merge; merge after the tap rebases onto main as it is, lands it, closes the card and pushes main", async () => {
  const repo = scratchRepo();
  heldBoard();
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const main = git(repo, 'rev-parse', 'main');
  const held = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(held.code, 0, held.err);
  assert.ok(held.out.includes('\nA1: verified; waits for your Merge\n'), held.out);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), itemOf().lane, itemOf().merge_ready.branch, typeof record().done], [main, 'review', 'me/orch/a1', 'string']);
  assert.equal(threadOf().at(-1).text, 'Checked it.');
  assert.equal(fs.existsSync(worktree()), true);

  const untapped = await onOrch('merge', 'w/A1');
  assert.deepEqual([untapped.code, untapped.err], [1, "w/A1 isn't waiting on a Merge tap\n"]);
  commit(repo, 'later.txt', 'main moved\n');
  tapMerge();
  const merged = await onOrch('merge', 'w/A1');
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
test('a Merge tap on a held build whose tested commit is still on top of main lands it without running the suite again; a main that moved is tested again', async () => {
  const repo = scratchRepo();
  heldBoard();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const held = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.ok(held.out.includes('tests passed: 1'), held.out);
  tapMerge();
  const merged = await onOrch('merge', 'w/A1');
  assert.equal(merged.code, 0, merged.err);
  assert.ok(merged.out.includes('me/orch/a1 was tested on main as it is now; not testing it again'), merged.out);
  assert.equal(merged.out.includes('tests passed'), false, merged.out);
  assert.equal(git(repo, 'show', 'main:work.txt'), 'built');
  assert.equal(git(repo, 'for-each-ref', 'refs/kickflip'), '');

  assert.equal((await onOrch('builder', 'start', 'w/ENG-1', '--worktree', '--repo', repo)).code, 0);
  const second = at('kickflip', 'worktrees', 'orch', 'ENG-1');
  commit(second, 'more.txt', 'more\n', 'feat: work\n\nRefs: ENG-1');
  assert.equal((await onOrch('builder', 'done', 'w/ENG-1', '--summary', 'Built it.', '--text', 'Checked it.')).code, 0);
  commit(repo, 'later.txt', 'main moved\n');
  tapMerge('ENG-1');
  const retested = await onOrch('merge', 'w/ENG-1');
  assert.equal(retested.code, 0, retested.err);
  assert.ok(retested.out.includes('rebased me/orch/eng-1 onto main'), retested.out);
  assert.ok(retested.out.includes('tests passed: 1'), retested.out);
});

test('a tapped Merge whose rebase conflicts launches a headless lander, and the lander finishes it onto main with no second tap', async () => {
  const repo = scratchRepo();
  heldBoard();
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const env = { KICKFLIP_CLAUDE: fake };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  // The build's run ended, so its launch is the lander's to take.
  fs.rmSync(site('orch', 'data', 'launches'), { recursive: true });
  commit(worktree(), 'shared/notes.md', 'branch\n', 'feat: work\n\nRefs: A1');
  assert.equal((await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.')).code, 0);
  commit(repo, 'shared/notes.md', 'main\n');
  const main = git(repo, 'rev-parse', 'main');
  tapMerge();
  const failed = await b('merge', 'w/A1');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^rebasing me\/orch\/a1 onto main conflicts in shared\/notes\.md/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.deepEqual(threadOf().slice(-1).map((m) => m.text), [
    'Not merged yet: rebasing me…/a1 onto main conflicts in… Its builder resumes to fix it and land it.',
  ]);
  await until(() => fs.existsSync(seen), 'the lander runs');
  assert.match(fs.readFileSync(seen, 'utf8'), /You are the headless lander for task A1/);

  // The lander resolves the conflict and finishes; the tap was the go.
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander')).code, 0);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  commit(worktree(), 'work.txt', 'built on main\n', 'feat: work, kept main\n\nRefs: A1');
  const landed = await b('builder', 'done', 'w/A1', '--text', 'Resolved it.');
  assert.equal(landed.code, 0, landed.err);
  assert.ok(landed.out.includes('\nA1: landed and done\n'), landed.out);
  assert.equal(itemOf().lane, 'done');
});

// docs/adr/2026-11-09-1500-a-builder-resumes-to-land-its-own-conflict.md
test("a tapped Merge whose rebase conflicts resumes the card's builder session, in its worktree, with the lander's brief, and says so in the thread", async () => {
  const repo = scratchRepo();
  heldBoard();
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const env = { KICKFLIP_CLAUDE: fake };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n', 'feat: work\n\nRefs: A1');
  assert.equal((await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.')).code, 0);
  fs.rmSync(site('orch', 'data', 'launches'), { recursive: true });
  const file = at('waves', 'w', 'agents', 'A1.json');
  write(file, { ...read(file), session: { id: 'sess-1', pid: 1, log: 'builder.log', at: new Date().toISOString() } });
  commit(repo, 'shared/notes.md', 'main\n');
  tapMerge();
  assert.equal((await b('merge', 'w/A1')).code, 1);
  await until(() => fs.existsSync(seen), 'the builder resumes');
  const [args] = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(args.slice(0, 2), ['--resume', 'sess-1']);
  assert.match(args[3], /^The board resumes you, the builder of task A1/);
  assert.match(args[3], /rebasing me\/orch\/a1 onto main conflicts in shared\/notes\.md/);
  assert.equal(threadOf().filter((l) => l.line === 'builder-resumed').length, 0, "the builder's section is still the thread's last thing");
});

test("Builder resumed is posted once, only when something came after the builder's section", async (t) => {
  onHome(t);
  heldBoard();
  const { appendBuilderResumed } = await import('./store.mjs');
  const orch = site('orch');
  const file = site('orch', 'data', 'threads', 'w__A1.jsonl');
  const add = (line) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ who: 'claude', ...line }) + '\n'); };
  const resumed = () => threadOf().filter((l) => l.line === 'builder-resumed').map((l) => l.text);
  add({ ts: '2026-11-14T10:00:00.000Z', kind: 'status', text: 'Landing: rebasing' });
  await appendBuilderResumed(orch, 'w/A1');
  assert.deepEqual(resumed(), [], 'right after the builder');
  add({ ts: '2026-11-14T10:05:00.000Z', text: 'Take another look.' });
  await appendBuilderResumed(orch, 'w/A1');
  assert.deepEqual(resumed(), ['Builder resumed'], 'after an orchestrator line');
  await appendBuilderResumed(orch, 'w/A1');
  assert.deepEqual(resumed(), ['Builder resumed'], 'a second resume in a row adds none');
});

test("a tapped Merge refused for a reason no lander fixes says why in the thread and leaves the card waiting for its Merge", async () => {
  const repo = scratchRepo();
  heldBoard();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.')).code, 0);
  git(repo, 'switch', '--quiet', '-c', 'elsewhere');
  tapMerge();
  const failed = await onOrch('merge', 'w/A1');
  assert.equal(failed.code, 1);
  assert.equal(threadOf().at(-1).line, 'land-failed');
  assert.match(threadOf().at(-1).text, /^Not merged: \S+ is.* Tap Merge again\.$/);
  assert.deepEqual([itemOf().lane, itemOf().merge_ready.branch], ['review', 'me/orch/a1']);
});

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md
test("the hub board's settings default to Merge, prs off, until its owner picks a PR mode; any other board defaults to PRs on", async () => {
  scratchRepo();
  const manifestFile = at('kickflip', 'manifest.json');
  const setOrch = (fields) => {
    const manifest = read(manifestFile);
    manifest.sites.orch = { dir: manifest.sites.orch.dir, port: 1, cmd: manifest.sites.orch.cmd, github: 'owner/project', branch: 'main', local: true, ...fields };
    write(manifestFile, manifest);
  };
  const prs = async () => JSON.parse((await board('--site', 'orch', 'settings')).out).prs;
  setOrch({ hub: true });
  assert.equal(await prs(), false);
  setOrch({});
  assert.equal(await prs(), true);
  setOrch({ hub: true });
  const cfgFile = site('orch', 'board.json');
  write(cfgFile, { ...read(cfgFile), prs: true });
  assert.equal(await prs(), true);
});

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md: what decides whether the board's cards
// show its reviewers.
test('the hub board opens PRs, and so shows reviewers, only on Draft PR or Ready PR; no other local board ever does', async () => {
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
test('on Merge, a hub card branches from its folder\'s main and lands there, opening no PR and pushing nothing without Push main', async () => {
  const ghDir = path.join(home, 'gh');
  const { origin, folder } = hubBoard();
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  const main = git(origin, 'rev-parse', 'main');
  assert.equal((await b('builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal(fs.existsSync(path.join(worktree(), 'local.txt')), true);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  const r = await b('builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.equal(git(folder, 'show', 'main:work.txt'), 'built');
  assert.equal(git(origin, 'rev-parse', 'main'), main);
  assert.deepEqual([itemOf().lane, itemOf().prs, calls(ghDir).filter((a) => a[0] === 'pr')], ['done', undefined, []]);
});

// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md
test("on Draft PR or Ready PR, a hub card branches from origin's main, and its finish pushes the branch and opens a draft PR holding only the card's commits, leaving main as it was", async () => {
  const ghDir = path.join(home, 'gh');
  const { origin, folder } = hubBoard();
  const titles = { A1: 'feat: one', A2: 'feat: two' };
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: titles.A1 }, { id: 'A2', title: titles.A2 }] });
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => boardWith(['--site', 'orch', ...args], env);
  for (const id of ['A1', 'A2']) launched('orch', `w/${id}`);
  const folderMain = git(folder, 'rev-parse', 'main');
  const originMain = git(origin, 'rev-parse', 'main');
  const finish = async (id) => {
    const tree = at('kickflip', 'worktrees', 'orch', id);
    assert.equal((await b('builder', 'start', `w/${id}`, '--kind', 'build')).code, 0);
    assert.equal(fs.existsSync(path.join(tree, 'local.txt')), false);
    commit(tree, `${id}.txt`, 'built\n', `feat: work\n\nRefs: ${id}`);
    const r = await b('builder', 'done', `w/${id}`, '--summary', 'Built it.', '--text', `Checked ${id}.`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`\\n${id}: draft PR #\\d+ opened\\n`));
    const branch = `me/orch/${id.toLowerCase()}`;
    assert.equal(git(origin, 'rev-parse', branch), git(tree, 'rev-parse', 'HEAD'));
    assert.equal(git(origin, 'rev-list', '--count', `main..${branch}`), '1');
    assert.deepEqual(calls(ghDir).filter((a) => a[0] === 'pr').at(-1), ['pr', 'create', '--draft', '--repo', 'owner/project', '--base', 'main', '--head', branch, '--title', titles[id], '--body', `Checked ${id}.`]);
    assert.deepEqual([itemOf(id).lane, itemOf(id).prs?.length], ['review', 1]);
  };
  assert.deepEqual(await b('settings', 'set', 'prs', 'on'), { code: 0, out: 'prs on\n', err: '' });
  await finish('A1');
  // Ready PR opens the same draft; the hub's GitHub check marks it ready once its CI passes.
  assert.equal((await b('settings', 'set', 'skip-draft', 'on')).code, 0);
  await finish('A2');
  assert.deepEqual([git(folder, 'rev-parse', 'main'), git(origin, 'rev-parse', 'main')], [folderMain, originMain]);
});

test('PRs off on a GitHub board needs Push main granted; then a finish lands in the shared clone on main as origin has it, and pushes main', async () => {
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  git(origin, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  const clone = path.join(home, 'clone');
  const refused = await onOrch('settings', 'set', 'prs', 'off');
  assert.deepEqual([refused.code, refused.err], [1, 'Merge lands each task on main and pushes it, so turn on Push main after a land first\n']);
  write(path.join(clone, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(clone, '.git', 'info', 'exclude'), '.claude\n');
  assert.deepEqual(await onOrch('settings', 'set', 'prs', 'off'), { code: 0, out: 'prs off\n', err: '' });
  // docs/adr/2026-11-19-1600-a-tasks-pr-is-commented-on-its-ticket.md: the land that pushes main comments the landed commit on the card's ticket.
  const ghDir = path.join(home, 'gh');
  const env = { PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const { saveBoardSettings } = await import('./store.mjs');
  await saveBoardSettings(site('orch'), { tickets: { source: 'github' } });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: wave().items.map((i) => (i.id === 'A1' ? { ...i, ticket: '#7' } : i)) });
  launched('orch', 'w/A1');
  assert.equal((await boardWith(['--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build'], env)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  commit(origin, 'later.txt', 'origin moved\n');
  const r = await boardWith(['--site', 'orch', 'builder', 'done', 'w/A1', '--summary', 'Built it.', '--text', 'Checked it.'], env);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\n#7: landed and done\n'), r.out);
  const landedSha = git(origin, 'rev-parse', 'main');
  assert.deepEqual(calls(ghDir).filter((a) => a[1] === 'comment'), [['issue', 'comment', '7', '--repo', 'owner/project', '--body', `Landed on main: [feat: work](https://github.com/owner/project/commit/${landedSha})`]]);
  assert.deepEqual(threadOf().filter((m) => m.line === 'ticket-commented').map((m) => m.text), ['Commented on #7.']);
  assert.ok(r.out.includes('\npushed main to origin\n'), r.out);
  assert.equal(git(origin, 'show', 'main:work.txt'), 'built');
  assert.equal(git(origin, 'show', 'main:later.txt'), 'origin moved');
  assert.deepEqual([itemOf().lane, itemOf().prs], ['done', undefined]);
});

test("a finished helper that started after the main build never stands for the card: builder verified lands the main worktree, and one that can't land says why", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'feat: work\n\nRefs: A1');
  assert.equal((await onOrch('builder', 'call', 'w/A1', 'Kept the old name')).code, 0);
  const helper = at('waves', 'w', 'agents', 'A1@page-tests.json');
  write(helper, { started: new Date(Date.now() + 60_000).toISOString(), done: new Date(Date.now() + 120_000).toISOString(), kind: 'helper', label: 'page-tests', worktree: { path: path.join(home, 'gone', 'A1-page-tests'), branch: 'A1-page-tests', repo } });
  const main = git(repo, 'rev-parse', 'main');
  const done = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^handed back: /m);
  assert.equal(typeof record().handed_back, 'string');
  const r = await onOrch('builder', 'verified', 'w/A1', '--note', 'Checked.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: judgment calls verified; landed and done\n'), r.out);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().lane, 'done');
});

test("builder verified names why it didn't land when the build hasn't handed back", async () => {
  const repo = scratchRepo();
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo)).code, 0);
  assert.equal((await onOrch('builder', 'call', 'w/A1', 'Kept the old name')).code, 0);
  const r = await onOrch('builder', 'verified', 'w/A1');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "A1: judgment calls verified; A1 didn't land: the build hasn't handed back; run builder done first\n");
});
