import fs from 'node:fs';
import path from 'node:path';
import { PR_VIEW_FIELDS } from '../hub/pr-report.mjs';

// n is a PR number, answered in any repo, or owner/repo#n, answered only in that repo and ahead of the bare number.
const write = (dir, folder, n, value) => {
  const file = path.join(dir, folder, `${String(n).replace(/[/#]/g, '__')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
export const writePR = (dir, n, value) => write(dir, 'pr', n, value);
export const writeIssueComments = (dir, n, value) => write(dir, 'issue-comments', n, value);
export const writeReviewComments = (dir, n, value) => write(dir, 'review-comments', n, value);
export const writeReviews = (dir, n, value) => write(dir, 'reviews', n, value);
// {error}: gh pr merge <n> fails, printing error.
export const writeMerge = (dir, n, value) => write(dir, 'merge', n, value);
// What gh pr view <n> --json title,body,commits answers, for a merge's squash message.
export const SQUASH_SOURCE = { title: 'feat: the work', body: 'Checked it.', commits: [{ messageBody: 'Refs: A1\nCo-Authored-By: Claude <noreply@anthropic.com>' }] };
// {error}: gh pr ready <n> fails, printing error.
export const writeReady = (dir, n, value) => write(dir, 'ready', n, value);
// [{number, headRefName, isCrossRepository}]: the open PRs the GraphQL query lists for repo (owner/name).
export const writeOpen = (dir, repo, value) => write(dir, 'open', repo, value);
export const writeUser = (dir, value) => write(dir, '', 'user', value);
// {login}: the GitHub user gh api users/<login> answers with; no file means no such user.
export const writeGithubUser = (dir, login, value = { login }) => write(dir, 'github-users', login, value);
// [{login}]: the collaborators of owner/repo.
export const writeCollaborators = (dir, repo, value) => write(dir, 'collaborators', repo.replace('/', '__'), value);
// {login: token}: the accounts gh auth token -u answers for.
export const writeAccounts = (dir, value) => write(dir, '', 'accounts', value);
const jsonl = (dir, name) => {
  try { return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
export const calls = (dir) => jsonl(dir, 'calls.jsonl');
// {remaining, resetAt}: the rate limit the GraphQL query answers, or {fail: true} to fail the whole query.
export const writeRate = (dir, value) => write(dir, '', 'rate', value);
// {core?, graphql?: reset ISO time}: GitHub's hourly limit holds those budgets, so a call spending one fails as GitHub
// answers it and gh api rate_limit shows it spent; {secondary: true}: every call that spends a budget hits the
// secondary limit, which rate_limit doesn't show.
export const writeLimit = (dir, value) => write(dir, '', 'limit', value);
// One entry per GraphQL query: the owner/repo#n of each PR it asked for, in order
// (not the repos it listed open PRs of).
export const queried = (dir) => calls(dir).filter((a) => a[0] === 'api' && a[1] === 'graphql')
  .map((a) => [...a[3].matchAll(/repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)].map(([, o, n, pr]) => `${o}/${n}#${pr}`));
// [{args, token}]: each call with the GH_TOKEN it ran with, or null.
export const tokens = (dir) => jsonl(dir, 'tokens.jsonl');
export function prView({ head = 'abc1234567', failing = [], pending = 0, ...over } = {}) {
  return {
    state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', headRefOid: head,
    statusCheckRollup: [
      ...failing.map((name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' })),
      ...Array.from({ length: pending }, (_, i) => ({ __typename: 'CheckRun', name: `ci-${i}`, status: 'IN_PROGRESS', conclusion: '' })),
    ], ...over,
  };
}
export function fakeGh(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
fs.appendFileSync(path.join(dir, 'tokens.jsonl'), JSON.stringify({ args, token: process.env.GH_TOKEN || null }) + '\\n');
const fail = () => { console.error('no fixture for: ' + args.join(' ')); process.exit(1); };
let limit = null;
try { limit = JSON.parse(fs.readFileSync(path.join(dir, 'limit.json'), 'utf8')); } catch {}
if (args[0] === 'api' && args[1] === 'rate_limit') {
  const budget = (b) => (limit?.[b] ? { limit: 5000, remaining: 0, reset: Math.floor(Date.parse(limit[b]) / 1000) } : { limit: 5000, remaining: 4990, reset: Math.floor(Date.now() / 1000) + 3600 });
  console.log(JSON.stringify({ resources: { core: budget('core'), graphql: budget('graphql') } }));
  process.exit(0);
}
const spends = args[0] === 'api' ? (args.slice(1).find((a) => !a.startsWith('-')) === 'graphql' ? 'graphql' : 'core')
  : ['pr', 'issue', 'repo'].includes(args[0]) ? 'graphql' : args[0] === 'run' || (args[0] === 'auth' && args[1] !== 'token') ? 'core' : null;
if (spends && limit?.secondary) { console.error('gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)'); process.exit(1); }
if (spends && limit?.[spends]) {
  if (args[1] === 'graphql') console.log(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit already exceeded for user ID 1.' }] }));
  console.error(spends === 'graphql' ? 'GraphQL: API rate limit already exceeded for user ID 1.' : 'gh: API rate limit exceeded for user ID 1. (HTTP 403)');
  process.exit(1);
}
// The repo's own fixture for PR n, else the one for n in any repo.
const fixture = (folder, repo, n) => {
  const own = path.join(dir, folder, repo.replace('/', '__') + '__' + n + '.json');
  return fs.existsSync(own) ? own : path.join(dir, folder, n + '.json');
};
if (args.length === 4 && args[0] === 'auth' && args[1] === 'token' && args[2] === '-u') {
  let accounts = {};
  try { accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')); } catch {}
  if (!accounts[args[3]]) { console.error('no oauth token found for github.com account ' + args[3]); process.exit(1); }
  console.log(accounts[args[3]]);
  process.exit(0);
}
if (args[0] === 'issue' && args.includes('--repo')) {
  const repo = args[args.indexOf('--repo') + 1];
  if (args[1] === 'create') {
    const n = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\\n').filter((l) => l.startsWith('["issue","create"')).length;
    console.log('https://github.com/' + repo + '/issues/' + n);
  } else if (args[1] === 'view') console.log(JSON.stringify(args[6] === 'number,url' ? { number: Number(args[2]), url: 'https://github.com/' + repo + '/issues/' + args[2] } : { state: 'OPEN', assignees: [] }));
  else if (args[1] !== 'close') fail();
  process.exit(0);
}
if (args.length >= 6 && args[0] === 'pr' && args[1] === 'merge' && /^\\d+$/.test(args[2]) && args[3] === '--repo' && args[5] === '--squash') {
  let refused = null;
  try { refused = JSON.parse(fs.readFileSync(fixture('merge', args[4], args[2]), 'utf8')).error; } catch {}
  if (refused) { console.error(refused); process.exit(1); }
  process.exit(0);
}
if (args.length === 5 && args[0] === 'pr' && args[1] === 'ready' && /^\\d+$/.test(args[2]) && args[3] === '--repo') {
  let refused = null;
  try { refused = JSON.parse(fs.readFileSync(fixture('ready', args[4], args[2]), 'utf8')).error; } catch {}
  if (refused) { console.error(refused); process.exit(1); }
  console.log('✓ Pull request ' + args[4] + '#' + args[2] + ' is marked as "ready for review"');
  process.exit(0);
}
// A comment or review-comment reply posted with gh api <endpoint> -f body=…: answers the endpoint as its html_url.
if (args.length === 4 && args[0] === 'api' && args[2] === '-f' && args[3].startsWith('body=') && /^repos\\/[^/]+\\/[^/]+\\/(issues\\/\\d+\\/comments|pulls\\/\\d+\\/comments\\/\\d+\\/replies)$/.test(args[1])) {
  console.log(JSON.stringify({ html_url: 'https://github.com/' + args[1].slice('repos/'.length) }));
  process.exit(0);
}
// A Comment review posted with gh api repos/<repo>/pulls/<n>/reviews -f body=… -f event=… -f commit_id=…: answers its html_url.
if (args.length === 8 && args[0] === 'api' && args[2] === '-f' && args[4] === '-f' && args[6] === '-f' && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+\\/reviews$/.test(args[1])) {
  console.log(JSON.stringify({ html_url: 'https://github.com/' + args[1].slice('repos/'.length).replace('/pulls/', '/pull/').replace(/\\/reviews$/, '') + '#pullrequestreview-1' }));
  process.exit(0);
}
// The hub's one GraphQL query (hub/pr-report.mjs fetchPRs), answered from the same fixtures as the REST calls: each
// aliased PR from its pr, issue-comments, review-comments and reviews fixtures, the viewer from user.json and the rate
// limit from rate.json. A PR without a fixture, or {fail: true}, comes back null with an error, as GitHub answers.
if (args.length === 4 && args[0] === 'api' && args[1] === 'graphql' && args[2] === '-f' && args[3].startsWith('query=')) {
  const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const rate = read(path.join(dir, 'rate.json'), { remaining: 4990, resetAt: '2026-10-23T12:00:00Z' });
  if (rate.fail) fail();
  const user = read(path.join(dir, 'user.json'), null);
  const author = (u) => (u?.login ? (/\\[bot\\]$/.test(u.login) ? { __typename: 'Bot', login: u.login.replace(/\\[bot\\]$/, '') } : { __typename: 'User', login: u.login }) : null);
  const list = (folder, repo, n) => { const v = read(fixture(folder, repo, n), []); return Array.isArray(v) ? v : []; };
  const data = { viewer: user ? { login: user.login } : null, rateLimit: rate };
  const errors = [];
  for (const [, alias, owner, name] of args[3].matchAll(/(open\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\) \\{ pullRequests\\(/g)) {
    data[alias] = { pullRequests: { nodes: read(path.join(dir, 'open', owner + '__' + name + '.json'), []) } };
  }
  for (const [, alias, owner, name, n] of args[3].matchAll(/(\\w+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\) \\{ pullRequest\\(number: (\\d+)\\)/g)) {
    const repo = owner + '/' + name;
    const view = read(fixture('pr', repo, n), null);
    if (!view || view.fail) { data[alias] = { pullRequest: null }; errors.push({ path: [alias, 'pullRequest'], message: 'Could not resolve to a PullRequest with the number of ' + n + '.' }); continue; }
    const { statusCheckRollup = [], ...fields } = view;
    data[alias] = { pullRequest: { ...fields,
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: statusCheckRollup } } } }] },
      comments: { nodes: list('issue-comments', repo, n).map((c) => ({ databaseId: c.id, author: author(c.user), createdAt: c.created_at, body: c.body, url: c.html_url })) },
      reviews: { nodes: list('reviews', repo, n).map((r) => ({ databaseId: r.id, author: author(r.user), submittedAt: r.submitted_at, body: r.body, state: r.state, url: r.html_url })) },
      reviewThreads: { nodes: list('review-comments', repo, n).map((c) => ({ comments: { nodes: [{ databaseId: c.id, author: author(c.user), createdAt: c.created_at, body: c.body, url: c.html_url, path: c.path, line: c.line, replyTo: c.in_reply_to_id == null ? null : { databaseId: c.in_reply_to_id } }] } })) },
    } };
  }
  console.log(JSON.stringify(errors.length ? { data, errors } : { data }));
  if (errors.length) { console.error('gh: ' + errors[0].message); process.exit(1); }
  process.exit(0);
}
// gh pr create --repo <repo> …: answers the new PR's URL, numbered 100 plus the creates before it.
if (args[0] === 'pr' && args[1] === 'create' && args.includes('--repo')) {
  const n = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\\n').filter((l) => l.startsWith('["pr","create"')).length;
  console.log('https://github.com/' + args[args.indexOf('--repo') + 1] + '/pull/' + (99 + n));
  process.exit(0);
}
if (args.length === 7 && args[0] === 'pr' && args[1] === 'view' && /^\\d+$/.test(args[2]) && args[3] === '--repo' && args[5] === '--json' && args[6] === 'title,body,commits') {
  console.log(${JSON.stringify(JSON.stringify(SQUASH_SOURCE))});
  process.exit(0);
}
let file;
let list = false;
if (args.length === 7 && args[0] === 'pr' && args[1] === 'view' && /^\\d+$/.test(args[2]) && args[3] === '--repo' && args[5] === '--json' && args[6] === ${JSON.stringify(PR_VIEW_FIELDS)}) file = fixture('pr', args[4], args[2]);
else if (args.length === 2 && args[0] === 'api' && args[1] === 'user') file = path.join(dir, 'user.json');
else if (args.length === 2 && args[0] === 'api' && /^users\\/[\\w-]+$/.test(args[1])) file = path.join(dir, 'github-users', args[1].slice(6) + '.json');
else if (args.length === 4 && args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp' && /^repos\\/[^/]+\\/[^/]+\\/collaborators$/.test(args[3])) {
  file = path.join(dir, 'collaborators', args[3].split('/').slice(1, 3).join('__') + '.json');
  list = true;
}
else if (args.length === 4 && args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp') {
  const match = /^repos\\/([^/]+\\/[^/]+)\\/(issues|pulls)\\/(\\d+)\\/(comments\\?since=.+|reviews)$/.exec(args[3]);
  if (!match || (match[2] === 'issues' && match[4] === 'reviews')) process.exit(1);
  file = fixture(match[4] === 'reviews' ? 'reviews' : match[2] === 'issues' ? 'issue-comments' : 'review-comments', match[1], match[3]);
  list = true;
} else process.exit(1);
let value;
try { value = fs.readFileSync(file, 'utf8'); } catch { if (!list) fail(); value = '[]'; }
if (list) {
  value = JSON.parse(value);
  if (value.fail) fail();
  const pages = [];
  for (let i = 0; i < value.length; i += 2) pages.push(value.slice(i, i + 2));
  console.log(JSON.stringify(pages));
} else {
  try { if (JSON.parse(value).fail) fail(); } catch {}
  console.log(value);
}
`, { mode: 0o755 });
  return bin;
}
