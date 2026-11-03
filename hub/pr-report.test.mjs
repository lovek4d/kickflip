import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPR, reportOf, githubLogin, PR_VIEW_FIELDS } from './pr-report.mjs';
import { fakeGh, prView, writePR, writeUser, writeIssueComments, writeReviewComments, writeReviews, calls } from '../shared/fake-gh.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-report-'));
const priorHome = process.env.HOME;
const priorPath = process.env.PATH;
process.env.HOME = home;
const { checkGitHub } = await import('./github.mjs');
const { listBoards } = await import('./boards.mjs');
let dir;
const since = '2026-10-23T10:00:00Z';
const input = { repo: 'o/r', pr: 7, since };
const comment = (id, login, at, body = `Comment ${id}`) => ({ id, user: { login }, created_at: at, body, html_url: `https://github.com/o/r/issues/7#issuecomment-${id}` });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const manifestOf = (specs) => ({ sites: Object.fromEntries(specs.map(({ route, login, prs, repo = 'o/r' }) => {
  const site = path.join(dir, route);
  write(path.join(site, 'board.json'), { items: 'data/wave.json', slug: route, github_login: login });
  write(path.join(site, 'data/wave.json'), { repo, items: prs.map((p) => ({ id: `A${p.pr}`, ...p })) });
  return [route, { dir: site, port: 1, cmd: [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname] }];
})) });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(home, 'fixture-'));
  process.env.PATH = `${fakeGh(dir)}:${priorPath}`;
  fs.rmSync(path.join(home, '.claude/kickflip'), { recursive: true, force: true });
  writePR(dir, 7, prView());
});
after(() => {
  process.env.HOME = priorHome;
  process.env.PATH = priorPath;
  fs.rmSync(home, { recursive: true, force: true });
});

test('labels and maps each REST event shape, drops Claude and bots, and merges by string time', async () => {
  writeIssueComments(dir, 7, [
    comment(1, 'owner', '2026-10-23T11:00:00Z'),
    comment(2, 'owner', '2026-10-23T11:01:00Z', '🤖 Done\n\n<!-- claude-bridge -->'),
    comment(3, 'chatgpt-codex-connector[bot]', '2026-10-23T11:02:00Z'),
    comment(4, 'renovate[bot]', '2026-10-23T11:03:00Z'),
    comment(5, 'linear', '2026-10-23T11:04:00Z'),
    comment(6, 'linear-app', '2026-10-23T11:05:00Z'),
    comment(7, 'ann', '2026-10-23T11:06:00Z'),
  ]);
  writeReviewComments(dir, 7, [{ ...comment(8, 'bea', '2026-10-23T11:00:30Z'), path: 'app.mjs', line: 12, in_reply_to_id: 88 }]);
  writeReviews(dir, 7, [{ id: 9, user: { login: 'ann' }, submitted_at: '2026-10-23T11:00:15Z', body: '', state: 'APPROVED' }]);
  const fetched = await fetchPR(input);
  const copy = structuredClone(fetched);
  const report = reportOf(fetched, { ...input, me: 'owner' });
  assert.deepEqual(report.events, [
    { kind: 'issue_comment', id: 1, login: 'owner', at: '2026-10-23T11:00:00Z', body: 'Comment 1', url: comment(1).html_url, who: 'user' },
    { kind: 'review', id: 9, login: 'ann', at: '2026-10-23T11:00:15Z', body: '', state: 'APPROVED', url: null, who: 'reviewer' },
    { kind: 'review_comment', id: 8, login: 'bea', at: '2026-10-23T11:00:30Z', body: 'Comment 8', path: 'app.mjs', line: 12, in_reply_to: 88, url: comment(8).html_url, who: 'reviewer' },
    { kind: 'issue_comment', id: 3, login: 'chatgpt-codex-connector[bot]', at: '2026-10-23T11:02:00Z', body: 'Comment 3', url: comment(3).html_url, who: 'codex' },
    { kind: 'issue_comment', id: 7, login: 'ann', at: '2026-10-23T11:06:00Z', body: 'Comment 7', url: comment(7).html_url, who: 'reviewer' },
  ]);
  assert.deepEqual(fetched, copy);
});

test('strictly filters since as a string, ignores unsubmitted reviews, and encodes endpoint since', async () => {
  writeIssueComments(dir, 7, [comment(1, 'ann', '2026-10-23T09:59:59Z'), comment(2, 'ann', since), comment(3, 'ann', '2026-10-23T10:00:00.999Z'), comment(4, 'ann', '2026-10-23T10:00:01Z')]);
  writeReviews(dir, 7, [{ id: 5, user: { login: 'ann' }, submitted_at: null }]);
  const report = reportOf(await fetchPR(input), { ...input, me: 'owner' });
  assert.deepEqual(report.events.map((e) => e.id), [4]);
  assert.deepEqual(calls(dir).sort(), [
    ['pr', 'view', '7', '--repo', 'o/r', '--json', PR_VIEW_FIELDS],
    ['api', '--paginate', '--slurp', `repos/o/r/issues/7/comments?since=${encodeURIComponent(since)}`],
    ['api', '--paginate', '--slurp', `repos/o/r/pulls/7/comments?since=${encodeURIComponent(since)}`],
    ['api', '--paginate', '--slurp', 'repos/o/r/pulls/7/reviews'],
  ].sort());
});

test('state fields follow null fallthrough, check conclusions and status-only pending counts', () => {
  const view = prView({ head: '1234567890abcdef', isDraft: true, reviewDecision: '', statusCheckRollup: [
    { name: 'failure', conclusion: 'FAILURE', status: 'COMPLETED' },
    { name: 'error', conclusion: 'ERROR', status: 'COMPLETED' },
    { context: 'legacy', state: 'ERROR' }, { context: 'waiting', state: 'PENDING' },
    { name: 'null conclusion', conclusion: null, state: 'FAILURE' },
    { name: 'empty conclusion', conclusion: '', state: 'FAILURE' },
    { name: '', context: 'fallback', conclusion: 'FAILURE' },
    { name: 'running', status: 'IN_PROGRESS' }, { status: '' }, { status: null },
  ] });
  const report = reportOf({ view, issueComments: [], reviewComments: [], reviews: [] }, { pr: '7', since, me: 'owner' });
  assert.deepEqual(report, { pr: 7, state: 'OPEN', isDraft: true, reviewDecision: '', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: '1234567890', failing: ['failure', 'error', 'legacy', 'null conclusion', ''], pending: 2, events: [] });
  const missing = reportOf({ view: {}, issueComments: [{ user: { login: 'ann' }, created_at: '2026-10-23T11:00:00Z' }], reviewComments: [{ created_at: '2026-10-23T12:00:00Z' }], reviews: [{ submitted_at: '2026-10-23T13:00:00Z' }] }, { ...input, me: 'owner' });
  assert.equal(missing.head, null);
  assert.equal(missing.state, null);
  assert.deepEqual(missing.events[0], { kind: 'issue_comment', id: null, login: 'ann', at: '2026-10-23T11:00:00Z', body: null, url: null, who: 'reviewer' });
  assert.deepEqual(missing.events[1], { kind: 'review_comment', id: null, login: null, at: '2026-10-23T12:00:00Z', body: null, path: null, line: null, in_reply_to: null, url: null, who: 'reviewer' });
  assert.equal(missing.events[2].state, null);
});

test('view failure and unreadable JSON name repo and PR; list failures are isolated', async () => {
  writePR(dir, 7, { fail: true });
  await assert.rejects(fetchPR(input), /^Error: o\/r#7: no fixture for:/);
  fs.writeFileSync(path.join(dir, 'pr/7.json'), 'not json');
  await assert.rejects(fetchPR(input), /^Error: o\/r#7: unreadable output/);
  writePR(dir, 7, prView());
  writeIssueComments(dir, 7, { fail: true });
  writeReviewComments(dir, 7, [comment(8, 'ann', '2026-10-23T11:00:00Z')]);
  writeReviews(dir, 7, { fail: true });
  const fetched = await fetchPR(input);
  assert.deepEqual(fetched.issueComments, []);
  assert.deepEqual(fetched.reviews, []);
  assert.deepEqual(reportOf(fetched, { ...input, me: 'owner' }).events.map((e) => e.id), [8]);
});

test('a configured board login labels posts and never asks gh api user', async () => {
  const manifest = manifestOf([{ route: 'configured', login: 'owner', prs: [{ pr: 7, gh_since: since }] }]);
  writeIssueComments(dir, 7, [comment(1, 'owner', '2026-10-23T11:00:00Z', '<!-- claude-bridge -->')]);
  const poll = await checkGitHub({ every: 15, manifest });
  assert.deepEqual(poll.failed, []);
  assert.deepEqual(poll.changes, []);
  assert.deepEqual(poll.checked, ['configured']);
  assert.ok(!calls(dir).some((a) => a[1] === 'user'));
  writeIssueComments(dir, 7, [comment(2, 'owner', '2026-10-23T11:01:00Z')]);
  assert.deepEqual((await checkGitHub({ every: 15, manifest })).changes[0].changes, ['comments']);
});

test('unconfigured boards resolve the login once per check and an empty manifest runs no gh', async () => {
  const manifest = manifestOf([{ route: 'first', prs: [{ pr: 7 }, { pr: 8 }] }, { route: 'second', login: 'invalid login', prs: [{ pr: 7 }] }]);
  writePR(dir, 8, prView());
  writeUser(dir, { login: 'owner' });
  assert.equal(listBoards(manifest)[1].githubLogin, null);
  const poll = await checkGitHub({ every: 15, manifest });
  assert.deepEqual(poll.failed, []);
  assert.equal(calls(dir).filter((a) => a[1] === 'user').length, 1);
  assert.equal(calls(dir).filter((a) => a[0] === 'pr').length, 2);
  await checkGitHub({ every: 15, manifest });
  assert.equal(calls(dir).filter((a) => a[1] === 'user').length, 2);
  fs.unlinkSync(path.join(dir, 'calls.jsonl'));
  await checkGitHub({ every: 15, manifest: {} });
  assert.deepEqual(calls(dir), []);
  await checkGitHub({ every: 15, manifest: manifestOf([{ route: 'idle', prs: [] }]) });
  assert.deepEqual(calls(dir), []);
});

test('a failed login is reported once, leaves its boards unreached, and configured boards still poll', async () => {
  const manifest = manifestOf([{ route: 'first', prs: [{ pr: 7 }] }, { route: 'second', prs: [{ pr: 8 }] }, { route: 'configured', login: 'owner', prs: [{ pr: 7 }] }]);
  const poll = await checkGitHub({ every: 15, manifest });
  assert.equal(poll.failed.length, 1);
  assert.ok(!poll.failed[0].includes('\n'));
  assert.deepEqual(poll.checked, ['configured']);
  assert.equal(poll.watched, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'first/data/checked.json')));
  assert.equal(calls(dir).filter((a) => a[1] === 'user').length, 1);
  assert.equal(calls(dir).filter((a) => a[0] === 'pr').length, 1);
  writeUser(dir, { login: 'owner' });
  assert.equal(await githubLogin(), 'owner');
});

test('same-login cards share the earliest fetch while different logins label independently without repeat wakes', async () => {
  const manifest = manifestOf([
    { route: 'owner', login: 'owner', prs: [{ pr: 7, gh_since: '2026-10-23T10:30:00Z' }] },
    { route: 'shared', login: 'owner', prs: [{ pr: 7, gh_since: since }] },
    { route: 'other', login: 'other', prs: [{ pr: 7, gh_since: since }] },
  ]);
  writeIssueComments(dir, 7, [comment(1, 'owner', '2026-10-23T11:00:00Z', '<!-- claude-bridge -->')]);
  const poll = await checkGitHub({ every: 15, manifest });
  assert.deepEqual(poll.events.map((e) => e.route), ['other']);
  assert.equal(poll.watched, 1);
  assert.equal(calls(dir).filter((a) => a[0] === 'pr').length, 2);
  assert.equal(calls(dir).filter((a) => a[3] === `repos/o/r/issues/7/comments?since=${encodeURIComponent(since)}`).length, 2);
  assert.deepEqual((await checkGitHub({ every: 15, manifest })).events, []);
});
