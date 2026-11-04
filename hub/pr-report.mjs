// GitHub's raw PR data and the session's report (docs/adr/2026-11-01-2314-the-hub-reads-github-itself.md).
import { execFile } from 'node:child_process';

export const PR_VIEW_FIELDS = 'state,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefOid,statusCheckRollup';
const GH_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const firstLine = (value) => String(value).trim().split(/\r?\n/)[0].slice(0, 200);

function gh(args, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { env: { ...env, PATH: [env.PATH, GH_PATH].filter(Boolean).join(':') }, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(firstLine(stderr || err.message)));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(firstLine(`unreadable output (${e.message})`))); }
    });
  });
}

// Every GitHub post Claude writes opens with the robot and ends with the marker reportOf reads as Claude's own.
export const CLAUDE_PREFIX = '🤖 ';
export const CLAUDE_MARK = '<!-- claude-bridge -->';

// Posts Claude's words on PR pr of repo: a comment, or with replyTo a reply in that review comment's thread, as login
// when given (its token from gh's own store, read each time since it can be rotated), else as gh's active account.
// → the post's url
export async function postToPR({ repo, pr, replyTo, words, login }) {
  let env = process.env;
  if (login) {
    const token = await new Promise((resolve) => execFile('gh', ['auth', 'token', '-u', login], { env: { ...env, PATH: [env.PATH, GH_PATH].filter(Boolean).join(':') } }, (err, stdout) => resolve(err ? '' : stdout.trim())));
    if (!token) throw new Error(`gh has no ${login} account; run gh auth login`);
    env = { ...env, GH_TOKEN: token };
  }
  const endpoint = replyTo === undefined ? `repos/${repo}/issues/${pr}/comments` : `repos/${repo}/pulls/${pr}/comments/${replyTo}/replies`;
  try { return (await gh(['api', endpoint, '-f', `body=${CLAUDE_PREFIX}${words}\n\n${CLAUDE_MARK}`], env)).html_url; }
  catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
}

export async function fetchPR({ repo, pr, since }) {
  let view;
  try { view = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', PR_VIEW_FIELDS]); }
  catch (e) { throw new Error(`${repo}#${pr}: ${e.message}`); }
  const list = (endpoint) => gh(['api', '--paginate', '--slurp', `repos/${repo}/${endpoint}`]).then((pages) => pages.flat()).catch(() => []);
  const [issueComments, reviewComments, reviews] = await Promise.all([
    list(`issues/${pr}/comments?since=${encodeURIComponent(since)}`),
    list(`pulls/${pr}/comments?since=${encodeURIComponent(since)}`),
    list(`pulls/${pr}/reviews`),
  ]);
  return { view, issueComments, reviewComments, reviews };
}

// The hub's check reads every PR in one GraphQL query, about half a point a PR, with no REST call
// (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md). GraphQL has no `since`,
// so each PR brings its last 50 comments, reviews and review threads of 20 comments, and reportOf filters them by time.
const AUTHOR = 'author { __typename login }';
const PR_QUERY_FIELDS = 'state isDraft reviewDecision mergeable mergeStateStatus headRefOid'
  + ' commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }'
  + ` comments(last: 50) { nodes { databaseId ${AUTHOR} createdAt body url } }`
  + ` reviews(last: 50) { nodes { databaseId ${AUTHOR} submittedAt body state url } }`
  + ` reviewThreads(last: 50) { nodes { comments(first: 20) { nodes { databaseId ${AUTHOR} createdAt body url path line replyTo { databaseId } } } } }`;

// gh api graphql answers a query that partly failed with its data and errors on stdout and a non-zero exit.
function graphql(query, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { env: { ...env, PATH: [env.PATH, GH_PATH].filter(Boolean).join(':') }, timeout: 90_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      let body = null;
      try { body = JSON.parse(stdout); } catch {}
      if (body?.data) return resolve(body);
      reject(new Error(`GitHub query: ${firstLine(err ? stderr || err.message : 'unreadable output')}`));
    });
  });
}

// REST's login for a GraphQL author: a bot's ends in [bot], as reportOf reads it.
const user = (a) => (a?.login ? { login: a.__typename === 'Bot' ? `${a.login}[bot]` : a.login } : null);

// prs: [{repo, pr}], each once. → {login: the account's, rate: {remaining, resetAt}, results}, results lined up with
// prs, each fetchPR's shape {view, issueComments, reviewComments, reviews}, or {error} for a PR GitHub didn't answer.
// Throws when the query fails as a whole.
export async function fetchPRs(prs) {
  const aliases = prs.map(({ repo, pr }, i) => {
    const [owner, name] = repo.split('/');
    return `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(pr)}) { ${PR_QUERY_FIELDS} } }`;
  });
  const { data, errors = [] } = await graphql(`query { viewer { login } rateLimit { remaining resetAt } ${aliases.join(' ')} }`);
  const results = prs.map(({ repo, pr }, i) => {
    const p = data[`pr${i}`]?.pullRequest;
    if (!p) return { error: `${repo}#${pr}: ${errors.find((e) => e.path?.[0] === `pr${i}`)?.message || 'GitHub did not answer for it'}` };
    const comment = (c) => ({ id: c.databaseId ?? null, user: user(c.author), created_at: c.createdAt ?? null, body: c.body ?? null, html_url: c.url ?? null });
    return {
      view: { state: p.state, isDraft: p.isDraft, reviewDecision: p.reviewDecision, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, headRefOid: p.headRefOid,
        statusCheckRollup: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [] },
      issueComments: (p.comments?.nodes ?? []).map(comment),
      reviewComments: (p.reviewThreads?.nodes ?? []).flatMap((t) => t.comments?.nodes ?? []).map((c) => ({ ...comment(c), path: c.path ?? null, line: c.line ?? null, in_reply_to_id: c.replyTo?.databaseId ?? null })),
      reviews: (p.reviews?.nodes ?? []).map((r) => ({ id: r.databaseId ?? null, user: user(r.author), submitted_at: r.submittedAt ?? null, body: r.body ?? null, state: r.state ?? null, html_url: r.url ?? null })),
    };
  });
  return { login: data.viewer?.login ?? null, rate: data.rateLimit ?? null, results };
}

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
  const checks = view.statusCheckRollup ?? [];
  return {
    pr: Number(pr), state: view.state ?? null, isDraft: view.isDraft ?? null, reviewDecision: view.reviewDecision ?? null,
    mergeable: view.mergeable ?? null, mergeStateStatus: view.mergeStateStatus ?? null, head: view.headRefOid?.slice(0, 10) ?? null,
    failing: checks.filter((c) => /FAILURE|ERROR/.test(c.conclusion ?? c.state ?? '')).map((c) => c.name ?? c.context ?? null),
    pending: checks.filter((c) => (c.status ?? 'COMPLETED') !== 'COMPLETED').length, events,
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
  const user = await gh(['api', 'user'], env);
  if (typeof user?.login !== 'string' || !user.login) throw new Error('gh api user: missing login');
  return user.login;
}
