// GitHub's raw PR data and the session's report (docs/adr/2026-11-01-2314-the-hub-reads-github-itself.md).
import { gh as ghRun, PRIMARY } from '../shared/gh.mjs';
import { githubSignOffLine } from './slack.mjs';

export const PR_VIEW_FIELDS = 'state,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefOid,statusCheckRollup';
// The hub runs under the host's service manager, whose PATH may not hold gh.
const GH_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const withPath = (env = process.env) => ({ ...env, PATH: [env.PATH, GH_PATH].filter(Boolean).join(':') });
const firstLine = (value) => String(value).trim().split(/\r?\n/)[0].slice(0, 200);

// One gh call through the gate (shared/gh.mjs), as account (its env carrying that account's token). → its JSON
async function gh(args, { env, account } = {}) {
  const r = await ghRun(args, { env: withPath(env), account, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw Object.assign(new Error(firstLine(r.stderr || `gh exited ${r.status}`)), { limited: r.limited });
  try { return JSON.parse(r.stdout); } catch (e) { throw new Error(firstLine(`unreadable output (${e.message})`)); }
}

// Every GitHub post Claude writes ends with the signature, then the marker reportOf reads as Claude's own.
export const CLAUDE_MARK = '<!-- claude-bridge -->';

// gh as login when given (its token from gh's own store, read each time since it can be rotated), else as gh's active
// account. → {env, account} for gh
async function asLogin(login) {
  if (!login) return { env: process.env, account: PRIMARY };
  const r = await ghRun(['auth', 'token', '-u', login], { env: withPath() });
  const token = r.status === 0 ? r.stdout.trim() : '';
  if (!token) throw new Error(`gh has no ${login} account; run gh auth login`);
  return { env: { ...process.env, GH_TOKEN: token }, account: login };
}

// A PR's head commit, as login, for a review posted at it. → its sha
export async function prHead({ repo, pr, login }) {
  try { return (await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'], await asLogin(login))).headRefOid; }
  catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

// A PR's title and size for its Slack link, as login. → {title, additions, deletions, files}
export async function prSize({ repo, pr, login }) {
  try {
    const v = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,additions,deletions,changedFiles'], await asLogin(login));
    return { title: v.title, additions: v.additions, deletions: v.deletions, files: v.changedFiles };
  } catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

// Posts Claude's words on PR pr of repo: a comment, or with replyTo a reply in that review comment's thread, as login.
// → the post's url
export async function postToPR({ repo, pr, replyTo, words, login }) {
  const as = await asLogin(login);
  const endpoint = replyTo === undefined ? `repos/${repo}/issues/${pr}/comments` : `repos/${repo}/pulls/${pr}/comments/${replyTo}/replies`;
  try { return (await gh(['api', endpoint, '-f', `body=${words}\n${githubSignOffLine()}\n\n${CLAUDE_MARK}`], as)).html_url; }
  catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

// Posts body as one Comment review (never an approval or a request for changes) on PR pr of repo at commit head, as
// login. → the review's url
export async function postReview({ repo, pr, head, body, login }) {
  const as = await asLogin(login);
  try { return (await gh(['api', `repos/${repo}/pulls/${pr}/reviews`, '-f', `body=${body}`, '-f', 'event=COMMENT', '-f', `commit_id=${head}`], as)).html_url; }
  catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

// The logins that collaborate on repo, as gh's active account sees them. Throws with gh's reason.
export async function collaborators(repo) {
  return (await gh(['api', '--paginate', '--slurp', `repos/${repo}/collaborators`])).flat().map((u) => u.login).sort((a, b) => a.localeCompare(b));
}

// A GitHub login's own spelling, or null when GitHub has no such user.
export async function githubUser(login) {
  try { return (await gh(['api', `users/${encodeURIComponent(login)}`])).login; } catch { return null; }
}

// The reviews and comments on PR pr of repo written after the ISO time since: its reviews, and its comments and inline
// review comments written or edited since (a bot's sticky comment is edited in place). → [{login, at, kind: review | comment}]
export async function reviewsSince({ repo, pr, since }) {
  const list = async (endpoint) => (await gh(['api', '--paginate', '--slurp', `repos/${repo}/${endpoint}`])).flat();
  const after = (at) => Date.parse(at) > Date.parse(since);
  try {
    const q = `?since=${encodeURIComponent(since)}`;
    const [reviews, comments, inline] = await Promise.all([list(`pulls/${pr}/reviews`), list(`issues/${pr}/comments${q}`), list(`pulls/${pr}/comments${q}`)]);
    return [
      ...reviews.filter((r) => after(r.submitted_at)).map((r) => ({ login: r.user?.login ?? null, at: r.submitted_at, kind: 'review' })),
      ...[...comments, ...inline].map((c) => ({ login: c.user?.login ?? null, at: c.updated_at ?? c.created_at, kind: 'comment' })).filter((c) => after(c.at)),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  } catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

// docs/adr/2026-11-25-0000-an-incoming-review-leads-with-the-boards-overlap.md
// What a review of PR pr of repo reads first, as login: its title, author, head, base branch and the commit it branched
// from main at (GitHub's merge base), every file it changes (a rename's old path too), its CI still running, and every
// review, comment and inline comment already on it, each marked bot when an app wrote it.
// → {title, author, head, base, mergeBase, files, pending, said: [{kind, login, bot, at, state?, path?, line?, body, url}]}
export async function prForReview({ repo, pr, login }) {
  const as = await asLogin(login);
  const list = async (endpoint) => (await gh(['api', '--paginate', '--slurp', `repos/${repo}/${endpoint}`], as)).flat();
  try {
    const view = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,author,baseRefName,headRefOid,statusCheckRollup'], as);
    const [changed, reviews, comments, inline, compare] = await Promise.all([
      list(`pulls/${pr}/files`), list(`pulls/${pr}/reviews`), list(`issues/${pr}/comments`), list(`pulls/${pr}/comments`),
      gh(['api', `repos/${repo}/compare/${encodeURIComponent(view.baseRefName)}...${view.headRefOid}`, '--jq', '{sha: .merge_base_commit.sha}'], as),
    ]);
    const by = (u) => ({ login: u?.login ?? null, bot: u?.type === 'Bot' || /\[bot\]$/.test(u?.login ?? '') });
    return {
      title: view.title, author: view.author?.login ?? null, head: view.headRefOid, base: view.baseRefName, mergeBase: compare.sha,
      files: [...new Set(changed.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))],
      pending: checksOf(view.statusCheckRollup ?? []).pending,
      said: [
        ...reviews.map((r) => ({ kind: 'review', ...by(r.user), at: r.submitted_at, state: r.state, body: r.body ?? '', url: r.html_url })),
        ...comments.map((c) => ({ kind: 'comment', ...by(c.user), at: c.updated_at ?? c.created_at, body: c.body ?? '', url: c.html_url })),
        ...inline.map((c) => ({ kind: 'inline', ...by(c.user), at: c.updated_at ?? c.created_at, path: c.path, line: c.line ?? null, body: c.body ?? '', url: c.html_url })),
      ].sort((a, b) => String(a.at).localeCompare(String(b.at))),
    };
  } catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

// Marks a draft PR ready for review as gh's active account, the one the finish opened it with (board/finish.mjs).
// Throws with gh's reason when GitHub refuses.
export async function markReady({ repo, pr }) {
  const r = await ghRun(['pr', 'ready', String(pr), '--repo', repo], { env: withPath(), timeout: 90_000 });
  if (r.status !== 0) throw new Error(firstLine(r.stderr || `gh exited ${r.status}`));
}

// docs/adr/2026-11-28-0128-a-check-is-its-newest-run.md: a status check rollup lists every run on the head commit, a
// rerun's replaced ones too, and a check is only its newest run, as GitHub's checks view reads it. A check run is its
// workflow and name, a status its context; the newest is the latest startedAt, a run not yet started newest of all.
const startOf = (c) => (c.startedAt ? Date.parse(c.startedAt) : Infinity);
export function latestRuns(rollup) {
  const newest = new Map();
  for (const c of rollup) {
    const check = JSON.stringify([c.workflowName ?? '', c.name || c.context || '']);
    if (!newest.has(check) || startOf(c) >= startOf(newest.get(check))) newest.set(check, c);
  }
  return [...newest.values()];
}
// A check's run read one way by every reader of the rollup: failed, pending, or else passed or skipped.
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const conclusionOf = (c) => (c.conclusion || c.state || '').toUpperCase();
const failed = (c) => FAILED.includes(conclusionOf(c));
const pendingRun = (c) => !failed(c) && ((c.status && c.status.toUpperCase() !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(conclusionOf(c)));

// Whether a PR's checks all passed: each check's newest run completed as a success, neutral or skip, and each status
// context's a success. A PR with no checks has nothing to fail.
export const checksPassed = (rollup) => latestRuns(rollup).every((c) => (c.__typename === 'StatusContext'
  ? c.state === 'SUCCESS' : c.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)));

// The PR's view, its reviews, and unless comments is false its comments since the ISO time since.
export async function fetchPR({ repo, pr, since, comments = true }) {
  let view;
  try { view = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', PR_VIEW_FIELDS]); }
  catch (e) { throw Object.assign(new Error(`${repo}#${pr}: ${e.message}`), { limited: e.limited }); }
  // A list GitHub can't give throws like the view does, so no caller reads a PR's reviews as none.
  const list = (endpoint) => gh(['api', '--paginate', '--slurp', `repos/${repo}/${endpoint}`]).then((pages) => pages.flat())
    .catch((e) => { throw Object.assign(new Error(`${repo}#${pr}: ${e.message}`), { limited: e.limited }); });
  const none = Promise.resolve([]);
  const [issueComments, reviewComments, reviews] = await Promise.all([
    comments ? list(`issues/${pr}/comments?since=${encodeURIComponent(since)}`) : none,
    comments ? list(`pulls/${pr}/comments?since=${encodeURIComponent(since)}`) : none,
    list(`pulls/${pr}/reviews`),
  ]);
  return { view, issueComments, reviewComments, reviews };
}

// The hub's check reads every PR in one GraphQL query, about half a point a PR, with no REST call
// (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md). GraphQL has no `since`,
// so each PR brings its last 50 comments, reviews and review threads of 20 comments, and reportOf filters them by time.
const AUTHOR = 'author { __typename login }';
// Title, size and whether anyone approved are for the PR's Slack link and its reactions; url, merge
// time, branch, update time and each reviewer's latest state are for the board's badges
// (docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md).
const PR_QUERY_FIELDS = 'state isDraft reviewDecision mergeable mergeStateStatus headRefOid title additions deletions changedFiles url mergedAt headRefName updatedAt'
  + ` latestReviews(first: 50) { nodes { state ${AUTHOR} } }`
  + ' commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes { __typename ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state createdAt } } } } } } }'
  + ` comments(last: 50) { nodes { databaseId ${AUTHOR} createdAt body url } }`
  + ` reviews(last: 50) { nodes { databaseId ${AUTHOR} submittedAt body state url } }`
  + ` reviewThreads(last: 50) { nodes { comments(first: 20) { nodes { databaseId ${AUTHOR} createdAt body url path line replyTo { databaseId } } } } }`;

// gh api graphql answers a query that partly failed with its data and errors on stdout and a non-zero exit.
async function graphql(query) {
  const r = await ghRun(['api', 'graphql', '-f', `query=${query}`], { env: withPath(), timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
  let body = null;
  try { body = JSON.parse(r.stdout); } catch {}
  if (body?.data) return body;
  throw new Error(`GitHub query: ${firstLine(r.status !== 0 ? r.stderr || `gh exited ${r.status}` : 'unreadable output')}`);
}

// REST's login for a GraphQL author: a bot's ends in [bot], as reportOf reads it.
const user = (a) => (a?.login ? { login: a.__typename === 'Bot' ? `${a.login}[bot]` : a.login } : null);

// A GraphQL rollup entry in gh pr view's shape, as fetchPR reads it: a check run's workflow name and a status's time
// as its startedAt.
function restRun({ checkSuite, createdAt, ...c }) {
  if (c.__typename === 'StatusContext') return { ...c, startedAt: createdAt ?? null };
  return { ...c, startedAt: c.startedAt ?? null, workflowName: checkSuite?.workflowRun?.workflow?.name ?? '' };
}

// A PR's CI for the board's badges, from each check's newest run: {total, fail, pending, state: fail | pending | pass | none}.
export function checksOf(rollup) {
  const latest = latestRuns(rollup);
  const fail = latest.filter(failed).length, pending = latest.filter(pendingRun).length;
  return { total: latest.length, fail, pending, state: fail ? 'fail' : pending ? 'pending' : latest.length ? 'pass' : 'none' };
}

// docs/adr/2026-11-05-1000-the-poll-links-a-pr-opened-by-hand-on-a-cards-branch.md: each repo also lists its newest 100 open PRs'
// head branches, for the poll to link a PR opened by hand on a card's branch.
const OPEN_QUERY_FIELDS = 'pullRequests(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number headRefName isCrossRepository } }';

// prs: [{repo, pr}], each once; repos: [owner/name], each once. → {login: the account's, rate: {remaining, resetAt}, results,
// open}, results lined up with prs, each fetchPR's shape {view, issueComments, reviewComments, reviews}, or {error} for a PR
// GitHub didn't answer; open maps each repo GitHub answered to its open PRs [{number, headRefName, isCrossRepository}].
// Throws when the query fails as a whole.
export async function fetchPRs(prs, repos = []) {
  const aliases = prs.map(({ repo, pr }, i) => {
    const [owner, name] = repo.split('/');
    return `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(pr)}) { ${PR_QUERY_FIELDS} } }`;
  });
  repos.forEach((repo, i) => {
    const [owner, name] = repo.split('/');
    aliases.push(`open${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${OPEN_QUERY_FIELDS} }`);
  });
  const { data, errors = [] } = await graphql(`query { viewer { login } rateLimit { remaining resetAt } ${aliases.join(' ')} }`);
  const open = Object.fromEntries(repos.flatMap((repo, i) => (data[`open${i}`]?.pullRequests ? [[repo, data[`open${i}`].pullRequests.nodes]] : [])));
  const results = prs.map(({ repo, pr }, i) => {
    const p = data[`pr${i}`]?.pullRequest;
    if (!p) return { error: `${repo}#${pr}: ${errors.find((e) => e.path?.[0] === `pr${i}`)?.message || 'GitHub did not answer for it'}` };
    const comment = (c) => ({ id: c.databaseId ?? null, user: user(c.author), created_at: c.createdAt ?? null, body: c.body ?? null, html_url: c.url ?? null });
    const reviewComments = (p.reviewThreads?.nodes ?? []).flatMap((t) => t.comments?.nodes ?? []).map((c) => ({ ...comment(c), path: c.path ?? null, line: c.line ?? null, in_reply_to_id: c.replyTo?.databaseId ?? null }));
    return {
      view: { state: p.state, isDraft: p.isDraft, reviewDecision: p.reviewDecision, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, headRefOid: p.headRefOid,
        statusCheckRollup: (p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(restRun),
        title: p.title ?? null, additions: p.additions ?? null, deletions: p.deletions ?? null, changedFiles: p.changedFiles ?? null,
        approved: (p.latestReviews?.nodes ?? []).some((r) => r.state === 'APPROVED' && r.author?.__typename !== 'Bot'),
        url: p.url ?? null, mergedAt: p.mergedAt ?? null, headRefName: p.headRefName ?? null, updatedAt: p.updatedAt ?? null,
        reviews: Object.fromEntries((p.latestReviews?.nodes ?? []).filter((r) => r.author?.login).map((r) => [r.author.login, r.state])) },
      issueComments: (p.comments?.nodes ?? []).map(comment),
      reviewComments,
      reviews: (p.reviews?.nodes ?? []).map((r) => ({ id: r.databaseId ?? null, user: user(r.author), submitted_at: r.submittedAt ?? null, body: r.body ?? null, state: r.state ?? null, html_url: r.url ?? null })),
    };
  });
  return { login: data.viewer?.login ?? null, rate: data.rateLimit ?? null, results, open };
}

// Whole word, any case: "kickflip-board" matches, "kickflipping" doesn't.
const OWNER_KEYWORD = /\b(claude|kickflip)\b/i;

export function reportOf({ view, issueComments, reviewComments, reviews }, { pr, since, me }) {
  const comment = (c, kind) => ({ kind, id: c.id ?? null, login: c.user?.login ?? null, at: c.created_at ?? null, body: c.body ?? null });
  const events = [
    ...issueComments.map((c) => ({ ...comment(c, 'issue_comment'), url: c.html_url ?? null })),
    ...reviewComments.map((c) => ({ ...comment(c, 'review_comment'), path: c.path ?? null, line: c.line ?? null, in_reply_to: c.in_reply_to_id ?? null, url: c.html_url ?? null })),
    ...reviews.map((r) => ({ kind: 'review', id: r.id ?? null, login: r.user?.login ?? null, at: r.submitted_at ?? null, body: r.body ?? null, state: r.state ?? null, url: r.html_url ?? null })),
  ].filter((e) => e.at != null && e.at > since).map((e) => ({
    ...e, who: e.login === me ? ((e.body ?? '').includes(CLAUDE_MARK) ? 'me' : 'user')
      : /codex/.test(e.login) ? 'codex' : /\[bot\]$|^linear/.test(e.login) ? 'bot' : 'reviewer',
  })).filter((e) => e.who !== 'me' && e.who !== 'bot').sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  // The owner's own comments get a reply only when they name Claude or kickflip; the rest are thread lines.
  const threadOnly = events.filter((e) => e.who === 'user' && !OWNER_KEYWORD.test(e.body ?? ''));
  const asked = events.filter((e) => !threadOnly.includes(e));
  const checks = view.statusCheckRollup ?? [];
  const latest = latestRuns(checks);
  return {
    pr: Number(pr), state: view.state ?? null, isDraft: view.isDraft ?? null, reviewDecision: view.reviewDecision ?? null,
    mergeable: view.mergeable ?? null, mergeStateStatus: view.mergeStateStatus ?? null, head: view.headRefOid?.slice(0, 10) ?? null,
    failing: latest.filter(failed).map((c) => c.name || c.context || null),
    pending: latest.filter(pendingRun).length, events: asked, threadOnly,
    title: view.title ?? null, additions: view.additions ?? null, deletions: view.deletions ?? null, files: view.changedFiles ?? null,
    approved: Boolean(view.approved),
    // The board's badges (fetchPRs; a REST fetchPR view has none but the CI and the full head).
    url: view.url ?? null, mergedAt: view.mergedAt ?? null, headRefName: view.headRefName ?? null, headRefOid: view.headRefOid ?? null,
    updatedAt: view.updatedAt ?? null, checks: checksOf(checks), reviews: view.reviews ?? {},
  };
}

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md: a repo's open PRs for hub/incoming.mjs, newest
// 100, with the files each changes and the users asked to review it.
export async function openPRs(repo) {
  let list;
  try { list = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,author,url,headRefOid,isDraft,files,reviewRequests']); }
  catch (e) { throw new Error(`${repo} open PRs: ${e.message}`); }
  return list.map((p) => ({
    number: p.number, title: p.title, author: p.author?.login ?? null, url: p.url, head: p.headRefOid?.slice(0, 10) ?? null, draft: Boolean(p.isDraft),
    files: (p.files || []).map((f) => f.path), requested: (p.reviewRequests || []).map((r) => r.login).filter(Boolean),
  }));
}

// One PR's state and changed files, for a card PR no longer open.
export async function prFiles(repo, pr) {
  let view;
  try { view = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,files']); }
  catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
  return { state: view.state ?? null, files: (view.files || []).map((f) => f.path) };
}

export async function githubLogin({ env } = {}) {
  const user = await gh(['api', 'user'], { env });
  if (typeof user?.login !== 'string' || !user.login) throw new Error('gh api user: missing login');
  return user.login;
}
