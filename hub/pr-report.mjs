// GitHub's raw PR data and the session's report (docs/adr/0103-the-hub-reads-github-itself.md).
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

export function reportOf({ view, issueComments, reviewComments, reviews }, { pr, since, me }) {
  const comment = (c, kind) => ({ kind, id: c.id ?? null, login: c.user?.login ?? null, at: c.created_at ?? null, body: c.body ?? null });
  const events = [
    ...issueComments.map((c) => ({ ...comment(c, 'issue_comment'), url: c.html_url ?? null })),
    ...reviewComments.map((c) => ({ ...comment(c, 'review_comment'), path: c.path ?? null, line: c.line ?? null, in_reply_to: c.in_reply_to_id ?? null, url: c.html_url ?? null })),
    ...reviews.map((r) => ({ kind: 'review', id: r.id ?? null, login: r.user?.login ?? null, at: r.submitted_at ?? null, body: r.body ?? null, state: r.state ?? null, url: r.html_url ?? null })),
  ].filter((e) => e.at != null && e.at > since).map((e) => ({
    ...e, who: e.login === me ? (/<!-- claude-bridge -->/.test(e.body ?? '') ? 'me' : 'user')
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

// docs/adr/0176-each-board-reviews-incoming-prs-that-touch-its-work.md: a repo's open PRs for hub/incoming.mjs, newest
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
