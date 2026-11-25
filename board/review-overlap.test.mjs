// docs/adr/2026-11-25-0000-an-incoming-review-leads-with-the-boards-overlap.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitNames, overlapOf, lineLevelOf } from './review-overlap.mjs';
import { fakeGh, writePR, writePRFiles, writeMergeBase, writeReviews, writeIssueComments, writeAccounts, tokens } from '../shared/fake-gh.mjs';
import { home, site, write, read, boardWith, bin } from './board-fixture.mjs';

test('a landed commit names its task by its subject\'s ticket suffix, and an older one by its Refs trailer', () => {
  assert.deepEqual(commitNames({ subject: 'feat(board): one thing (#1174)', body: 'Detail.\n\nRefs: #1174\nCo-Authored-By: C' }), ['#1174']);
  assert.deepEqual(commitNames({ subject: 'feat(board): older', body: 'Refs: T-12, #9' }), ['T-12', '#9']);
  assert.deepEqual(commitNames({ subject: 'chore: no ref', body: '' }), []);
});

test('overlap keeps the open and landed tasks that share a file with the PR, and their notes\' lines naming one', () => {
  const r = overlapOf({
    files: ['board/asks.mjs', 'SKILL.md'],
    live: [{ key: 'w/T-1', title: 'a', lane: 'In Progress', files: ['board/asks.mjs', 'board/x.mjs'] }, { key: 'w/T-2', title: 'b', lane: 'Todo', files: ['README.md'] }],
    landed: [{ key: 'w/T-3', title: 'c', files: ['SKILL.md', 'SKILL.md'], commits: ['abc'] }],
    notes: { 'w/T-1': 'The guard lives in asks.mjs, not domain.\nNothing here.\nmyasks.mjs is another file.', 'w/T-3': 'SKILL.md gets the paragraph.' },
  });
  assert.deepEqual(r.live.map((t) => [t.key, t.shared]), [['w/T-1', ['board/asks.mjs']]]);
  assert.deepEqual(r.landed.map((t) => [t.key, t.shared]), [['w/T-3', ['SKILL.md']]]);
  assert.deepEqual(r.decisions, [{ key: 'w/T-1', line: 'The guard lives in asks.mjs, not domain.' }, { key: 'w/T-3', line: 'SKILL.md gets the paragraph.' }]);
  assert.deepEqual(overlapOf({ files: ['z'], live: [], landed: [] }), { live: [], landed: [], decisions: [] });
});

test('a line-level review is not due once a bot reviewed or left inline comments, waits while CI runs, and is due otherwise, a deploy bot\'s comment included', () => {
  const ann = { kind: 'comment', login: 'ann', bot: false };
  const deploy = { kind: 'comment', login: 'vercel[bot]', bot: true };
  assert.deepEqual(lineLevelOf({ said: [ann, deploy, { kind: 'review', login: 'claude[bot]', bot: true }], pending: 2 }), { due: false, bots: ['claude[bot]'] });
  assert.deepEqual(lineLevelOf({ said: [deploy, { kind: 'inline', login: 'lint[bot]', bot: true }], pending: 0 }), { due: false, bots: ['lint[bot]'] });
  assert.deepEqual(lineLevelOf({ said: [ann, deploy], pending: 0 }), { due: true });
  assert.deepEqual(lineLevelOf({ said: [ann], pending: 2 }), { wait: 2 });
  assert.deepEqual(lineLevelOf({ said: [ann], pending: 0 }), { due: true });
});

const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test('review overlap prints the PR against open worktrees and tasks landed since it branched, what was said on it, and whether a line-level review is due', async () => {
  const dir = path.join(home, 'fake-gh-overlap');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { owner: 'token-owner' });
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(repo, f), `${f}\n`);
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'chore: start');
  const base = sh(repo, 'rev-parse', 'HEAD');
  const wt = path.join(home, 'wt-T-1');
  sh(repo, 'worktree', 'add', '-q', '-b', 'b1', wt, 'main');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'landed\n');
  sh(repo, 'commit', '-qam', 'feat: b (#41)');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'older\n');
  sh(repo, 'commit', '-qam', 'feat: c', '-m', 'Refs: T-3');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'nobody\n');
  sh(repo, 'commit', '-qam', 'chore: not the board\'s');

  write(home + '/.claude/kickflip/manifest.json', { sites: { audit: { dir: site('audit'), local: true, github: 'o/r', owner: { repo }, cmd: [process.execPath, bin('../server.mjs')] } } });
  write(site('audit', 'board.json'), { ...read(site('audit', 'board.json')), tickets: { source: 'github' } });
  write(site('audit', 'data', 'items.json'), { title: 'W', items: [
    { id: 'T-1', title: 'feat: a', lane: 'progress', notes: 'a.txt stays one line.\nUnrelated.' },
    { id: 'T-2', title: 'feat: b', lane: 'done', ticket: '#41', notes: 'b.txt reads landed.' },
    { id: 'T-3', title: 'feat: c', lane: 'done', notes: 'c.txt is old.' },
    { id: 'T-4', title: 'feat: d', lane: 'todo' },
  ] });
  write(site('audit', 'data', 'agents', 'T-1.json'), { kind: 'claude', started: '2026-11-24T10:00:00Z', worktree: { path: wt, branch: 'b1', repo } });

  writePR(dir, 7, { title: 'Touch things', author: { login: 'quinn' }, headRefOid: 'h7', statusCheckRollup: [] });
  writePRFiles(dir, 7, [{ filename: 'a.txt' }, { filename: 'b2.txt', previous_filename: 'b.txt' }, { filename: 'c.txt' }, { filename: 'z.txt' }]);
  writeMergeBase(dir, 7, base);
  writeReviews(dir, 7, [{ user: { login: 'claude[bot]', type: 'Bot' }, submitted_at: '2026-11-24T09:00:00Z', state: 'COMMENTED', body: 'Missing the bench table.', html_url: 'https://github.com/o/r/pull/7#r1' }]);
  writeIssueComments(dir, 7, [{ user: { login: 'ann' }, created_at: '2026-11-24T09:30:00Z', body: 'Looks fine to me.', html_url: 'https://github.com/o/r/pull/7#c1' }]);
  assert.equal((await boardWith(['--site', 'audit', 'settings', 'set', 'github-login', 'owner'], env)).code, 0);

  const r = await boardWith(['--site', 'audit', 'review', 'overlap', 'https://github.com/o/r/pull/7'], env);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  assert.match(lines[0], /^PR #7 "Touch things" by quinn, read at \d{4}-\d\d-\d\dT[\d:.]+Z: pass that to review post --read-at$/);
  assert.deepEqual(lines.slice(1), [
    "Overlap with this board's work (lead the review with it):",
    '- open, In Progress: audit/T-1 "feat: a" also changes a.txt; expect a conflict at whichever lands second',
    `- landed since the PR branched (${sh(repo, 'rev-parse', '--short=7', 'HEAD~2')}): audit/T-2 (#41) "feat: b" changed b.txt; check the PR builds on it and doesn't undo it`,
    `- landed since the PR branched (${sh(repo, 'rev-parse', '--short=7', 'HEAD~1')}): audit/T-3 "feat: c" changed c.txt; check the PR builds on it and doesn't undo it`,
    'Their notes on those files (a decision the PR may contradict):',
    '- audit/T-1: a.txt stays one line.',
    '- audit/T-2: b.txt reads landed.',
    '- audit/T-3: c.txt is old.',
    'Already said on the PR (repeat none of it):',
    '- claude[bot] (bot), review, commented, 2026-11-24T09:00:00Z: https://github.com/o/r/pull/7#r1',
    '    Missing the bench table.',
    '- ann, comment, 2026-11-24T09:30:00Z: https://github.com/o/r/pull/7#c1',
    '    Looks fine to me.',
    'Line-level review: not due, as claude[bot] reviewed it; add one only when the owner or the asker asks for it in words',
  ]);
  assert.ok(tokens(dir).filter((c) => c.args[0] !== 'auth').every((c) => c.token === 'token-owner'), 'read as the board\'s github-login');

  // No bot and CI running: wait; CI done: due. A PR touching none of the board's work says so.
  writeReviews(dir, 7, []);
  writePR(dir, 7, { title: 'Touch things', author: { login: 'quinn' }, headRefOid: 'h7', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: '' }] });
  assert.match((await boardWith(['--site', 'audit', 'review', 'overlap', 'o/r#7'], env)).out, /Line-level review: wait, 1 CI check is still running and an automated review may follow; run review overlap again once they finish\n$/);
  writePR(dir, 7, { title: 'Touch things', author: { login: 'quinn' }, headRefOid: 'h7', statusCheckRollup: [] });
  writePRFiles(dir, 7, [{ filename: 'z.txt' }]);
  writeIssueComments(dir, 7, [{ user: { login: 'vercel[bot]', type: 'Bot' }, created_at: '2026-11-24T09:10:00Z', body: 'Deployed.', html_url: 'https://github.com/o/r/pull/7#c2' }]);
  const none = await boardWith(['--site', 'audit', 'review', 'overlap', '7'], env);
  assert.match(none.out, /\n- no overlap: no open task's worktree and no task landed since the PR branched changes its files\nAlready said on the PR \(repeat none of it\):\n/);
  assert.match(none.out, /- vercel\[bot\] \(bot\), comment, 2026-11-24T09:10:00Z: https:\/\/github\.com\/o\/r\/pull\/7#c2\n/);
  assert.match(none.out, /Line-level review: due, as no automated reviewer has reviewed this PR\n$/, "a deploy bot's comment alone isn't a reviewer");
  assert.match((await boardWith(['--site', 'audit', 'review', 'overlap', 'seven'], env)).err, /review overlap takes the PR's link, owner\/repo#n or its number, not "seven"/);
});

test('review post refuses when a comment, a bot\'s sticky one edited in place included, came after --read-at', async () => {
  const dir = path.join(home, 'fake-gh-comment');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { owner: 'token-owner' });
  write(home + '/.claude/kickflip/manifest.json', { sites: { orch: { dir: site('orch'), port: 1, github: 'o/r', cmd: [process.execPath, '/skill/board/server.mjs', site('orch')] } } });
  write(site('orch', 'data', 'incoming.json'), { at: 'x', repo: 'o/r', prs: [{ number: 437, title: 'T', author: 'quinn', url: 'u', head: 'abc', touches: [], asked: true }] });
  write(site('orch', 'data', 'reviews.json'), {});
  write(path.join(home, 'review.md'), 'One point.\n');
  writeIssueComments(dir, 437, [{ user: { login: 'claude[bot]' }, created_at: '2026-11-05T08:00:00Z', updated_at: '2026-11-05T10:00:00Z', body: 'Review: …' }]);
  const cli = (...args) => boardWith(['--site', 'orch', ...args], env);
  assert.match((await cli('review', 'post', '437', '--file', path.join(home, 'review.md'), '--read-at', '2026-11-05T09:00:00Z')).err,
    /PR #437 got a comment after 2026-11-05T09:00:00Z \(claude\[bot\] at 2026-11-05T10:00:00Z\); reread the PR/);
  assert.equal((await cli('review', 'post', '437', '--file', path.join(home, 'review.md'), '--read-at', '2026-11-05T10:30:00Z')).code, 0);
});
