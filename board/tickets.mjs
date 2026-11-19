import { runRepo, validateGithub } from '../hub/repos.mjs';
import { savedClient } from '../hub/linear.mjs';

const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
// A board's ticket source: GitHub issues, Linear, or none, which returns null; with none every card is a task
// (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md). The retired Internal source is refused.
export function ticketSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Tickets must name a source.');
  const allowed = { none: ['source'], github: ['source', 'account'], linear: ['source', 'workspace', 'team', 'project'] };
  if (!Object.hasOwn(allowed, value.source)) refuse('Ticket source must be none, github or linear.');
  if (Object.keys(value).some((k) => !allowed[value.source].includes(k))) refuse('Unknown ticket source field.');
  if (value.source === 'none') return null;
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
const issueNumber = (id) => numberOf(/^(?:#|GH-)?([1-9]\d*)$/.exec(String(id ?? '')));
const keyOf = (source) => (source.source === 'linear' ? source.team : null);

// The number of a stored ticket id that belongs to the source (#n or TEAM-n), else null: an id from
// another source is never relabelled as this one's.
export function ticketIn(source, id) {
  if (!source) return null;
  const key = keyOf(source);
  const s = String(id ?? '');
  if (!key) return numberOf(/^#([1-9]\d*)$/.exec(s));
  return s.startsWith(`${key}-`) ? numberOf(/^([1-9]\d*)$/.exec(s.slice(key.length + 1))) : null;
}

// The ticket a card id or --ticket value names in the source's own forms (#n or GH-<n> on GitHub, TEAM-n on Linear),
// as it is stored, else null: a board with no source names none.
export function ticketNamed(source, id) {
  if (!source) return null;
  if (source.source === 'linear') return ticketIn(source, id) ? String(id) : null;
  const n = issueNumber(id);
  return n && /^(?:#|GH-)/.test(String(id)) ? `#${n}` : null;
}

export function ticketBadge(source, id, { repo } = {}) {
  const n = ticketIn(source, id);
  if (!n) return null;
  if (source.source === 'github') return repo ? { id: `#${n}`, url: `https://github.com/${repo}/issues/${n}`, source: 'github' } : null;
  const ref = `${source.team}-${n}`;
  return { id: ref, url: `https://linear.app/${source.workspace}/issue/${ref}`, source: 'linear' };
}

// A GitHub source's issue calls run as its account, with GH_TOKEN from gh's own store, read each time because the
// token can be rotated underneath. Without an account they run as gh's active account
// (docs/adr/2026-11-02-1611-the-hub-board-files-its-cards-as-github-issues.md). → a runner for gh
async function issueRunner(source, run) {
  if (!source.account) return run;
  const token = await run('gh', ['auth', 'token', '-u', source.account]);
  if (token.status !== 0 || !token.stdout?.trim()) refuse(`gh has no ${source.account} account; run gh auth login`);
  const as = { ...process.env, GH_TOKEN: token.stdout.trim() };
  return (command, argv) => run(command, argv, { env: as, account: source.account });
}

const linearCall = async (fn) => { try { return await fn(); } catch (e) { refuse(e.message); } };

// → {ticket, created}: created when kickflip made the ticket rather than linking one, assigned to the owner (cards.mjs
// keeps it as ticket_created, which moveTicket counts as the owner's). A Linear board without Hub's key is refused, so
// a card never goes with a ticket it couldn't make (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).
export async function resolveTicket(source, { ticket, title, body = '', repo }, { run = runRepo, linearFetch } = {}) {
  if (source.source === 'linear') {
    if (ticket !== undefined && !ticketIn(source, ticket)) refuse(`Ticket must match ${source.team}-<number>.`);
    const linear = savedClient({ fetch: linearFetch });
    if (!linear) refuse('Hub has no Linear key, so this board can’t create Linear tickets; add it in Hub › Integrations › Linear, or pick another ticket source.');
    if (ticket === undefined) {
      const issue = await linearCall(() => linear.createIssue({ team: source.team, project: source.project, title, description: body, assignee: linear.saved.viewer?.id }));
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
    : ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--assignee', '@me'];
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

// The id of a card named from its ticket: the ticket, or GH-<n> for issue #n, since a card id names files and branches.
export const cardIdOf = (ticket) => (ticket.startsWith('#') ? `GH-${ticket.slice(1)}` : ticket);

// The ids in a card's title that belong to the source, in order: #n or TEAM-n.
export function titleTickets(source, title) {
  const found = source.source === 'github' ? String(title ?? '').match(/(?<![\w#])#[1-9]\d*\b/g) : String(title ?? '').match(/\b[A-Z][A-Z0-9]*-[1-9]\d*\b/g);
  return [...new Set((found || []).filter((id) => ticketIn(source, id)))];
}

// The ticket a card's move asks for: a close → done, a build's start → started, a handover (a PR, a push, a verified
// merge-ready build) → review.
export function ticketTarget({ start, done, handover }) {
  if (done) return 'done';
  if (start) return 'started';
  if (handover) return 'review';
  return null;
}

const TARGET_WORDS = { started: 'In Progress', review: 'In Review', done: 'Done' };

// docs/adr/2026-11-19-1430-a-ticket-moves-when-it-is-yours-and-says-so-in-its-thread.md
// Moves a card's ticket toward target, one way, and only a ticket that is the owner's: one kickflip created (assigned to
// the owner at creation) or one assigned to the owner (the key's viewer, or gh's user). A build's start makes an
// unassigned ticket the owner's first; at review or done an unassigned one stays as it is, with no line. A GitHub issue
// has no In Progress or In Review, so its start only assigns it and its done closes it.
// → {kind, inputs} of the status line (hub-lines.mjs ticket-*) the move writes in the card's thread, or null when there
// is nothing to say. Never throws.
export async function moveTicket(source, item, target, { repo, run = runRepo, linearFetch } = {}) {
  const ticket = item.ticket;
  if (!source || !target || !ticket || !ticketIn(source, ticket)) return null;
  if (source.source === 'github' && (target === 'review' || (target === 'started' && item.ticket_created))) return null;
  const failed = (why) => ({ kind: 'ticket-failed', inputs: { ticket, ...(target === 'done' ? {} : { to: TARGET_WORDS[target] }), why: String(why?.message || why).split('\n')[0] } });
  const left = { kind: 'ticket-left', inputs: { ticket } };
  if (source.source === 'github' && !repo) return failed('the board has no GitHub repo');
  try {
    if (source.source === 'linear') {
      const linear = savedClient({ fetch: linearFetch });
      if (!linear) return failed('Hub has no Linear key');
      const me = linear.saved.viewer?.id;
      let assign = false;
      if (!item.ticket_created) {
        const issue = await linear.issue(ticket);
        if (!issue) return failed('Linear has no such issue');
        if (['completed', 'canceled'].includes(issue.state.type)) return null;
        if (issue.assignee && issue.assignee !== me) return left;
        if (!issue.assignee && target !== 'started') return null;
        assign = !issue.assignee;
      }
      if (assign) await linear.assignIssue(ticket, me);
      const moved = await linear.moveIssue(ticket, target);
      if (!moved) return assign ? { kind: 'ticket-assigned', inputs: { ticket } } : null;
      return target === 'done' ? { kind: 'ticket-closed', inputs: { ticket, state: moved } } : { kind: 'ticket-moved', inputs: { ticket, state: moved, assigned: assign } };
    }
    const n = ticket.slice(1);
    const gh = await issueRunner(source, run);
    const call = async (argv) => {
      const out = await gh('gh', argv);
      if (out.status !== 0) throw new Error(out.stderr || `gh ${argv.slice(0, 2).join(' ')} failed`);
      return out.stdout;
    };
    if (!item.ticket_created) {
      const issue = JSON.parse(await call(['issue', 'view', n, '--repo', repo, '--json', 'state,assignees']));
      if (issue.state !== 'OPEN') return null;
      const assignees = issue.assignees || [];
      if (!assignees.length) {
        if (target !== 'started') return null;
        await call(['issue', 'edit', n, '--repo', repo, '--add-assignee', '@me']);
        return { kind: 'ticket-assigned', inputs: { ticket } };
      }
      const login = (await call(['api', 'user', '--jq', '.login'])).trim().toLowerCase();
      if (!assignees.some((a) => a.login?.toLowerCase() === login)) return left;
      if (target === 'started') return null;
    }
    await call(['issue', 'close', n, '--repo', repo]);
    return { kind: 'ticket-closed', inputs: { ticket } };
  } catch (e) { return failed(e); }
}
