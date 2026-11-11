import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPR, fetchPRs, reportOf, githubLogin, PR_VIEW_FIELDS } from './pr-report.mjs';
import { fakeGh, prView, writePR, writeUser, writeIssueComments, writeReviewComments, writeReviews, writeRate, calls, queried } from '../shared/fake-gh.mjs';

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
  write(path.join(site, 'board.json'), { items: 'data/items.json', slug: route, github_login: login });
  write(path.join(site, 'data/items.json'), { repo, items: prs.map((p) => ({ id: `A${p.pr}`, ...p })) });
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
  assert.deepEqual(report, { pr: 7, state: 'OPEN', isDraft: true, reviewDecision: '', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: '1234567890', failing: ['failure', 'error', 'legacy', 'null conclusion', ''], pending: 2, events: [],
    title: null, additions: null, deletions: null, files: null, approved: false, commits: [],
    url: null, mergedAt: null, headRefName: null, headRefOid: '1234567890abcdef', updatedAt: null, checks: { total: 10, fail: 6, pending: 2, state: 'fail' }, reviews: {}, codexOpen: 0 });
  const missing = reportOf({ view: {}, issueComments: [{ user: { login: 'ann' }, created_at: '2026-10-23T11:00:00Z' }], reviewComments: [{ created_at: '2026-10-23T12:00:00Z' }], reviews: [{ submitted_at: '2026-10-23T13:00:00Z' }] }, { ...input, me: 'owner' });
  assert.equal(missing.head, null);
  assert.equal(missing.state, null);
  assert.deepEqual(missing.events[0], { kind: 'issue_comment', id: null, login: 'ann', at: '2026-10-23T11:00:00Z', body: null, url: null, who: 'reviewer' });
  assert.deepEqual(missing.events[1], { kind: 'review_comment', id: null, login: null, at: '2026-10-23T12:00:00Z', body: null, path: null, line: null, in_reply_to: null, url: null, who: 'reviewer' });
  assert.equal(missing.events[2].state, null);
});

test('view failure and unreadable JSON name repo and PR; a failed list throws too', async () => {
  writePR(dir, 7, { fail: true });
  await assert.rejects(fetchPR(input), /^Error: o\/r#7: no fixture for:/);
  fs.writeFileSync(path.join(dir, 'pr/7.json'), 'not json');
  await assert.rejects(fetchPR(input), /^Error: o\/r#7: unreadable output/);
  writePR(dir, 7, prView());
  writeIssueComments(dir, 7, []);
  writeReviewComments(dir, 7, []);
  writeReviews(dir, 7, { fail: true });
  await assert.rejects(fetchPR(input), /^Error: o\/r#7: no fixture for:/);
  writeReviews(dir, 7, []);
  writeIssueComments(dir, 7, { fail: true });
  await assert.rejects(fetchPR(input), /^Error: o\/r#7: no fixture for:/);
  const fetched = await fetchPR({ ...input, comments: false });
  assert.deepEqual([fetched.issueComments, fetched.reviewComments, fetched.reviews], [[], [], []]);
});

test('a configured board login labels posts, and the check never asks gh api user', async () => {
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

test('unconfigured boards take the login from the one query, and an empty manifest runs no gh', async () => {
  const manifest = manifestOf([{ route: 'first', prs: [{ pr: 7 }, { pr: 8 }] }, { route: 'second', login: 'invalid login', prs: [{ pr: 7 }] }]);
  writePR(dir, 8, prView());
  writeUser(dir, { login: 'owner' });
  assert.equal(listBoards(manifest)[1].githubLogin, null);
  const poll = await checkGitHub({ every: 5, manifest });
  assert.deepEqual(poll.failed, []);
  assert.deepEqual(poll.checked, ['first', 'second']);
  assert.deepEqual(poll.rate, { remaining: 4990, resetAt: '2026-10-23T12:00:00Z' });
  assert.deepEqual(queried(dir), [['o/r#7', 'o/r#8']]);
  assert.equal(calls(dir).length, 1);
  await checkGitHub({ every: 5, manifest });
  assert.equal(queried(dir).length, 2);
  fs.unlinkSync(path.join(dir, 'calls.jsonl'));
  assert.equal((await checkGitHub({ every: 5, manifest: {} })).rate, null);
  assert.deepEqual(calls(dir), []);
  // A board with a repo and no PR still asks for its repo's open PRs (hub/github.mjs linkHandPRs).
  await checkGitHub({ every: 5, manifest: manifestOf([{ route: 'idle', prs: [] }]) });
  assert.deepEqual(queried(dir), [[]]);
  assert.equal(calls(dir).length, 1);
});

test('a failed query is reported once and reaches no board; a PR GitHub can\'t resolve leaves only its boards unreached', async () => {
  const manifest = manifestOf([{ route: 'first', prs: [{ pr: 7 }] }, { route: 'second', prs: [{ pr: 8 }] }, { route: 'configured', login: 'owner', prs: [{ pr: 7 }] }]);
  writeUser(dir, { login: 'owner' });
  writeRate(dir, { fail: true });
  const poll = await checkGitHub({ every: 5, manifest });
  assert.equal(poll.failed.length, 1);
  assert.ok(!poll.failed[0].includes('\n'));
  assert.deepEqual(poll.checked, []);
  assert.equal(poll.watched, 2);
  assert.equal(poll.rate, null);
  assert.ok(!fs.existsSync(path.join(dir, 'first/data/checked.json')));
  writeRate(dir, { remaining: 900, resetAt: '2026-10-23T12:00:00Z' });
  const partial = await checkGitHub({ every: 5, manifest });
  assert.deepEqual(partial.failed, ['o/r#8: Could not resolve to a PullRequest with the number of 8.']);
  assert.deepEqual(partial.checked, ['first', 'configured']);
  assert.equal(partial.rate.remaining, 900);
  assert.equal(await githubLogin(), 'owner');
});

test('cards on several boards share one read of their PR while different logins label independently without repeat wakes', async () => {
  const manifest = manifestOf([
    { route: 'owner', login: 'owner', prs: [{ pr: 7, gh_since: '2026-10-23T10:30:00Z' }] },
    { route: 'shared', login: 'owner', prs: [{ pr: 7, gh_since: since }] },
    { route: 'other', login: 'other', prs: [{ pr: 7, gh_since: since }] },
  ]);
  writeIssueComments(dir, 7, [comment(1, 'owner', '2026-10-23T11:00:00Z', '<!-- claude-bridge -->')]);
  const poll = await checkGitHub({ every: 5, manifest });
  assert.deepEqual(poll.events.map((e) => e.route), ['other']);
  assert.equal(poll.watched, 1);
  assert.deepEqual(queried(dir), [['o/r#7']]);
  assert.deepEqual((await checkGitHub({ every: 5, manifest })).events, []);
});

test('fetchPRs reads every PR in one GraphQL query, in the shapes reportOf reads, with the login and points left', async () => {
  writeUser(dir, { login: 'owner' });
  writeRate(dir, { remaining: 4321, resetAt: '2026-10-23T12:00:00Z' });
  writePR(dir, 'o/site#3', prView({ isDraft: true, failing: ['lint'], title: 'Fix limiter', additions: 84, deletions: 12, changedFiles: 5,
    latestReviews: { nodes: [{ state: 'COMMENTED' }, { state: 'APPROVED' }] }, recent: { nodes: [{ commit: { oid: 'aaa0000000ffff', messageHeadline: 'Add limiter' } }, { commit: { oid: 'bbb0000000ffff', messageHeadline: 'Fix reset' } }] } }));
  writeIssueComments(dir, 7, [
    comment(1, 'owner', '2026-10-23T11:00:00Z'),
    comment(2, 'owner', '2026-10-23T11:01:00Z', '🤖 Done\n\n<!-- claude-bridge -->'),
    comment(3, 'chatgpt-codex-connector[bot]', '2026-10-23T11:02:00Z'),
    comment(4, 'renovate[bot]', '2026-10-23T11:03:00Z'),
    comment(5, 'linear', '2026-10-23T11:04:00Z'),
    comment(6, 'ann', '2026-10-23T09:00:00Z'),
  ]);
  writeReviewComments(dir, 7, [{ ...comment(8, 'bea', '2026-10-23T11:00:30Z'), path: 'app.mjs', line: 12, in_reply_to_id: 88 }]);
  writeReviews(dir, 7, [{ id: 9, user: { login: 'ann' }, submitted_at: '2026-10-23T11:00:15Z', body: '', state: 'APPROVED' }]);
  const { login, rate, results } = await fetchPRs([{ repo: 'o/r', pr: 7 }, { repo: 'o/site', pr: 3 }]);
  assert.equal(login, 'owner');
  assert.deepEqual(rate, { remaining: 4321, resetAt: '2026-10-23T12:00:00Z' });
  assert.deepEqual(queried(dir), [['o/r#7', 'o/site#3']]);
  assert.equal(calls(dir).length, 1);
  const report = reportOf(results[0], { ...input, me: login });
  assert.deepEqual(report.events, [
    { kind: 'issue_comment', id: 1, login: 'owner', at: '2026-10-23T11:00:00Z', body: 'Comment 1', url: comment(1).html_url, who: 'user' },
    { kind: 'review', id: 9, login: 'ann', at: '2026-10-23T11:00:15Z', body: '', state: 'APPROVED', url: null, who: 'reviewer' },
    { kind: 'review_comment', id: 8, login: 'bea', at: '2026-10-23T11:00:30Z', body: 'Comment 8', path: 'app.mjs', line: 12, in_reply_to: 88, url: comment(8).html_url, who: 'reviewer' },
    { kind: 'issue_comment', id: 3, login: 'chatgpt-codex-connector[bot]', at: '2026-10-23T11:02:00Z', body: 'Comment 3', url: comment(3).html_url, who: 'codex' },
  ]);
  assert.deepEqual(reportOf(results[0], { ...input, me: login }), reportOf(await fetchPR(input), { ...input, me: login }));
  const site = reportOf(results[1], { repo: 'o/site', pr: 3, since, me: login });
  assert.deepEqual([site.isDraft, site.failing, site.head], [true, ['lint'], 'abc1234567']);
  // The PR's Slack link and push replies read its title, size, whether anyone approved and its newest commits.
  assert.deepEqual([site.title, site.additions, site.deletions, site.files, site.approved, site.commits], ['Fix limiter', 84, 12, 5, true, [{ oid: 'aaa0000000', subject: 'Add limiter' }, { oid: 'bbb0000000', subject: 'Fix reset' }]]);
});

// docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md
test("the query brings what a board's badges draw: url, merge time, branch, update time, CI counts, each reviewer's state and open Codex findings", async () => {
  writeUser(dir, { login: 'owner' });
  writePR(dir, 7, prView({ failing: ['lint'], pending: 1, head: 'f'.repeat(40), url: 'https://github.com/o/r/pull/7', mergedAt: null, headRefName: 'A7', updatedAt: '2026-10-23T11:30:00Z',
    latestReviews: { nodes: [{ state: 'APPROVED', author: { __typename: 'User', login: 'ann' } }, { state: 'CHANGES_REQUESTED', author: { __typename: 'User', login: 'bea' } }] } }));
  const codex = 'chatgpt-codex-connector[bot]';
  writeReviewComments(dir, 7, [
    { ...comment(20, codex, '2026-10-23T09:00:00Z'), path: 'a.mjs', line: 1 },
    { ...comment(21, codex, '2026-10-23T09:01:00Z'), path: 'a.mjs', line: 2 },
    { ...comment(22, 'owner', '2026-10-23T09:02:00Z'), path: 'a.mjs', line: 1, in_reply_to_id: 20 },
    { ...comment(23, codex, '2026-10-23T09:03:00Z'), path: 'a.mjs', line: 1, in_reply_to_id: 20 },
    { ...comment(24, 'bea', '2026-10-23T09:04:00Z'), path: 'b.mjs', line: 3 },
  ]);
  const { results } = await fetchPRs([{ repo: 'o/r', pr: 7 }]);
  const report = reportOf(results[0], { ...input, me: 'owner' });
  assert.deepEqual({ url: report.url, mergedAt: report.mergedAt, headRefName: report.headRefName, headRefOid: report.headRefOid, updatedAt: report.updatedAt, checks: report.checks, reviews: report.reviews, codexOpen: report.codexOpen }, {
    url: 'https://github.com/o/r/pull/7', mergedAt: null, headRefName: 'A7', headRefOid: 'f'.repeat(40), updatedAt: '2026-10-23T11:30:00Z',
    checks: { total: 2, fail: 1, pending: 1, state: 'fail' }, reviews: { ann: 'APPROVED', bea: 'CHANGES_REQUESTED' },
    // 20 has a reply and a codex reply (23) isn't a finding of its own: 21 is the one open.
    codexOpen: 1,
  });
});

test('a PR GitHub can\'t resolve fails alone, and a query that fails fails as a whole', async () => {
  writeUser(dir, { login: 'owner' });
  const { results } = await fetchPRs([{ repo: 'o/r', pr: 7 }, { repo: 'o/r', pr: 9 }]);
  assert.equal(results[0].view.state, 'OPEN');
  assert.match(results[1].error, /^o\/r#9: Could not resolve to a PullRequest/);
  writeRate(dir, { fail: true });
  await assert.rejects(fetchPRs([{ repo: 'o/r', pr: 7 }]), /^Error: GitHub query: no fixture for:/);
});

test("a repo's collaborators come as sorted logins, and a GitHub user is found by login in its own spelling or is null", async () => {
  const { collaborators, githubUser } = await import('./pr-report.mjs');
  const { writeCollaborators, writeGithubUser } = await import('../shared/fake-gh.mjs');
  writeCollaborators(dir, 'o/r', [{ login: 'zed' }, { login: 'Ann' }, { login: 'bob' }]);
  assert.deepEqual(await collaborators('o/r'), ['Ann', 'bob', 'zed']);
  assert.deepEqual(await collaborators('o/other'), []);
  writeGithubUser(dir, 'ann', { login: 'Ann' });
  assert.equal(await githubUser('ann'), 'Ann');
  assert.equal(await githubUser('ghost'), null);
});
