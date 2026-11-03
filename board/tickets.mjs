import { runRepo, validateGithub } from '../hub/repos.mjs';
import { savedClient } from '../hub/linear.mjs';

const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export function ticketSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Tickets must name a source.');
  const allowed = { internal: ['source', 'prefix'], github: ['source', 'account'], linear: ['source', 'workspace', 'team', 'project'] };
  if (!Object.hasOwn(allowed, value.source)) refuse('Ticket source must be internal, github or linear.');
  if (Object.keys(value).some((k) => !allowed[value.source].includes(k))) refuse('Unknown ticket source field.');
  if (value.source === 'internal') {
    const prefix = value.prefix === undefined || value.prefix === '' ? 'INT' : value.prefix;
    if (typeof prefix !== 'string' || !/^[A-Z]{2,6}$/.test(prefix)) refuse('Prefix must be 2–6 uppercase letters.');
    return { source: 'internal', prefix };
  }
  if (value.source === 'github') {
    if (value.account === undefined || value.account === '') return { source: 'github' };
    if (typeof value.account !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.account)) refuse('The gh account must be a GitHub login.');
    return { source: 'github', account: value.account };
  }
  if (typeof value.workspace !== 'string' || !/^[a-z\d][a-z\d-]*$/i.test(value.workspace)) refuse('Linear needs a workspace.');
  if (typeof value.team !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(value.team)) refuse('Linear needs an uppercase team key.');
  if (typeof value.project !== 'string' || !value.project.trim()) refuse('Linear needs a project.');
  return { source: 'linear', workspace: value.workspace, team: value.team, project: value.project.trim() };
}

const numberOf = (match) => {
  const n = match ? Number(match[1]) : null;
  return Number.isSafeInteger(n) ? n : null;
};
const issueNumber = (id) => numberOf(/^#?([1-9]\d*)$/.exec(String(id ?? '')));
const keyOf = (source) => (source.source === 'internal' ? source.prefix || 'INT' : source.source === 'linear' ? source.team : null);

// The number of a stored ticket id that belongs to the source (PREFIX-n, #n or TEAM-n), else null: an id from
// another source is never relabelled as this one's.
export function ticketIn(source, id) {
  if (!source) return null;
  const key = keyOf(source);
  const s = String(id ?? '');
  if (!key) return numberOf(/^#([1-9]\d*)$/.exec(s));
  return s.startsWith(`${key}-`) ? numberOf(/^([1-9]\d*)$/.exec(s.slice(key.length + 1))) : null;
}

export function ticketBadge(source, id, { repo, key } = {}) {
  const n = ticketIn(source, id);
  if (!n) return null;
  if (source.source === 'internal') return { id: `${keyOf(source)}-${n}`, url: `#item=${encodeURIComponent(key)}`, source: 'internal' };
  if (source.source === 'github') return repo ? { id: `#${n}`, url: `https://github.com/${repo}/issues/${n}`, source: 'github' } : null;
  const ref = `${source.team}-${n}`;
  return { id: ref, url: `https://linear.app/${source.workspace}/issue/${ref}`, source: 'linear' };
}

// A GitHub source's issue calls run as its account, with GH_TOKEN from gh's own store, read each time because the
// token can be rotated underneath. Without an account they run as gh's active account
// (docs/adr/0115-the-hub-board-files-its-cards-as-github-issues.md). → a runner for gh
async function issueRunner(source, run) {
  if (!source.account) return run;
  const token = await run('gh', ['auth', 'token', '-u', source.account]);
  if (token.status !== 0 || !token.stdout?.trim()) refuse(`gh has no ${source.account} account; run gh auth login`);
  const as = { ...process.env, GH_TOKEN: token.stdout.trim() };
  return (command, argv) => run(command, argv, { env: as });
}

const linearCall = async (fn) => { try { return await fn(); } catch (e) { refuse(e.message); } };

// → {ticket, created}: created when kickflip made the ticket rather than linking one (store.mjs keeps it as
// ticket_created, which lets moveTicket move it). A Linear board without Hub's key links an id on its pattern alone,
// and to create one answers {ticket: null, mcp: true}: the board's session makes it through its Linear MCP
// (docs/adr/0088-kickflip-reaches-linear-with-a-key-on-the-mac.md).
export async function resolveTicket(source, { ticket, title, body = '', repo, next }, { run = runRepo, linearFetch } = {}) {
  if (source.source === 'internal') {
    if (ticket !== undefined && !ticketIn(source, ticket)) refuse(`Ticket must match ${source.prefix}-<number>.`);
    return { ticket: ticket ?? `${source.prefix}-${next}`, created: ticket === undefined };
  }
  if (source.source === 'linear') {
    if (ticket !== undefined && !ticketIn(source, ticket)) refuse(`Ticket must match ${source.team}-<number>.`);
    const linear = savedClient({ fetch: linearFetch });
    if (!linear) return ticket === undefined ? { ticket: null, created: false, mcp: true } : { ticket, created: false };
    if (ticket === undefined) {
      const issue = await linearCall(() => linear.createIssue({ team: source.team, project: source.project, title, description: body }));
      return { ticket: issue.identifier, created: true };
    }
    const issue = await linearCall(() => linear.issue(ticket));
    if (!issue) refuse(`Linear has no issue ${ticket}.`);
    if (issue.team !== source.team) refuse(`${ticket} is in Linear's ${issue.team} team, not ${source.team}.`);
    return { ticket: issue.identifier, created: false };
  }
  validateGithub(repo);
  const n = ticket === undefined ? null : issueNumber(ticket);
  if (ticket !== undefined && !n) refuse('GitHub ticket must be an issue number such as #41.');
  const argv = n ? ['issue', 'view', String(n), '--repo', repo, '--json', 'number,url']
    : ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  const out = await (await issueRunner(source, run))('gh', argv);
  if (out.status !== 0) refuse((out.stderr || 'GitHub refused the issue.').trim().split('\n')[0]);
  let url;
  if (n) {
    let issue;
    try { issue = JSON.parse(out.stdout); } catch { refuse('GitHub returned an invalid issue.'); }
    if (issue.number !== n) refuse('GitHub returned a different issue.');
    url = issue.url;
  } else url = out.stdout?.trim();
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(url || '');
  if (!match || match[1].toLowerCase() !== repo.toLowerCase() || (n && Number(match[2]) !== n) || !issueNumber(match[2])) refuse('Ticket must be an issue in the board’s repo.');
  return { ticket: `#${match[2]}`, created: !n };
}

// The ids in a card's title that belong to the source, in order: PREFIX-n, #n or TEAM-n.
export function titleTickets(source, title) {
  const found = source.source === 'github' ? String(title ?? '').match(/(?<![\w#])#[1-9]\d*\b/g) : String(title ?? '').match(/\b[A-Z][A-Z0-9]*-[1-9]\d*\b/g);
  return [...new Set((found || []).filter((id) => ticketIn(source, id)))];
}

// The ticket a card's status asks for: building or fixing → started, a PR → review, done or merged → done.
export function ticketTarget({ status, pr }) {
  if (['done', 'merged'].includes(status)) return 'done';
  if (['building', 'fixing'].includes(status)) return 'started';
  if (pr !== undefined && status === undefined) return 'review';
  return null;
}

const TARGET_WORDS = { started: 'In Progress', review: 'In Review', done: 'Done' };

// Moves a card's ticket toward target, one way, and only a ticket the owner is assigned or kickflip created
// (docs/adr/0088-kickflip-reaches-linear-with-a-key-on-the-mac.md). Internal tickets are the card itself; GitHub issues
// only close, on done. → a line to print, or null when nothing was asked of the source. Never throws.
export async function moveTicket(source, item, target, { repo, run = runRepo, linearFetch } = {}) {
  const id = item.ticket;
  if (!source || !target || !id || !ticketIn(source, id) || source.source === 'internal') return null;
  if (source.source === 'github' && target !== 'done') return null;
  if (source.source === 'github' && !repo) return `ticket ${id}: not closed, the board has no GitHub repo`;
  const why = (e) => `ticket ${id}: could not move to ${TARGET_WORDS[target]} (${String(e.message || e).split('\n')[0]})`;
  try {
    if (source.source === 'linear') {
      const linear = savedClient({ fetch: linearFetch });
      if (!linear) return `ticket ${id}: move to ${TARGET_WORDS[target]} through the Linear MCP${item.ticket_created ? '' : " if it's assigned to you"}`;
      if (!item.ticket_created) {
        const issue = await linear.issue(id);
        if (!issue) return `ticket ${id}: not moved, Linear has no such issue`;
        if (issue.assignee !== linear.saved.viewer?.id) return `ticket ${id}: left as it is, not assigned to you`;
      }
      const moved = await linear.moveIssue(id, target);
      return moved ? `ticket ${id}: moved to ${moved}` : null;
    }
    const n = id.slice(1);
    const gh = await issueRunner(source, run);
    if (!item.ticket_created) {
      const view = await gh('gh', ['issue', 'view', n, '--repo', repo, '--json', 'state,assignees']);
      if (view.status !== 0) throw new Error(view.stderr || 'gh issue view failed');
      const me = await gh('gh', ['api', 'user', '--jq', '.login']);
      if (me.status !== 0) throw new Error(me.stderr || 'gh api user failed');
      const issue = JSON.parse(view.stdout);
      if (issue.state !== 'OPEN') return null;
      if (!(issue.assignees || []).some((a) => a.login?.toLowerCase() === me.stdout.trim().toLowerCase())) return `ticket ${id}: left as it is, not assigned to you`;
    }
    const closed = await gh('gh', ['issue', 'close', n, '--repo', repo]);
    if (closed.status !== 0) throw new Error(closed.stderr || 'gh issue close failed');
    return `ticket ${id}: closed`;
  } catch (e) { return why(e); }
}

// The line that asks a board's session to make a Linear issue through its MCP and link it with link (a board.mjs command).
export const mcpCreateLine = (source, title, link) => `ticket: create the Linear issue "${title}" in team ${source.team}, project ${source.project}, through your Linear MCP, then run ${link} --ticket <id>`;
