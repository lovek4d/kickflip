// docs/adr/2026-11-19-1700-one-ticket-layer-arbitrates-every-ticket-action.md
// The ticket layer: a board's ticket source, its ids, and every ticket action (link or create, move, the hub's PR
// poll) through one provider per source behind one assignee policy. Nothing else reaches GitHub or Linear for a ticket.
import { runRepo, validateGithub } from '../hub/repos.mjs';
import { savedClient } from '../hub/linear.mjs';
import { audit, hubAudit } from '../shared/audit.mjs';

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

// A card's ticket as its branch names it (worktree.mjs boardBranch): the issue's number, or TEAM-n; else null.
export function ticketSlug(source, id) {
  const n = ticketIn(source, id);
  if (!n) return null;
  return keyOf(source) ? `${keyOf(source)}-${n}` : String(n);
}

// A card's legacy Linear links (item.linear), on any board, as badges {id, url}: linked while the board's source names
// a Linear workspace. board/public/ui-links.js links Linear ids in text from these urls.
export const linkedTickets = (source, item) => (item.linear || []).map((id) => ({ id, url: source?.workspace ? `https://linear.app/${source.workspace}/issue/${id}` : null }));

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

// The ticket providers, one per source. open(source, ctx) → the source's calls, or null when it can't be reached
// (unreached says why, to a link and to a move):
// - link(id) → the stored id of an existing ticket; create({title, body}) → the stored id of a new one, assigned to
//   the owner;
// - read(id) → {open, assignee: 'mine', 'none' or 'other'}, plus what move needs;
// - assign(id) to the owner;
// - comment(id, body) posts a comment;
// - move(id, issue, target) → {state} it moved to, {} for a close with no state name, or null when the ticket is
//   there or past it, or the source has no state for target. A wontdo target closes the ticket as not planned (GitHub)
//   or moves it to a canceled state (Linear).
// targets: the targets the source has a state for. followsPRs: the hub's PR poll moves its tickets (followPRs).
const PROVIDERS = {
  github: {
    targets: ['done', 'wontdo'],
    followsPRs: false,
    unreached: { link: 'Repo must be owner/name on GitHub.', move: 'the board has no GitHub repo' },
    async open(source, { repo, run = runRepo }) {
      if (!repo) return null;
      validateGithub(repo);
      const gh = await issueRunner(source, run);
      const call = async (argv) => {
        const out = await gh('gh', argv);
        if (out.status !== 0) throw new Error((out.stderr || `gh ${argv.slice(0, 2).join(' ')} failed`).trim().split('\n')[0]);
        return out.stdout;
      };
      const inRepo = (url, n) => {
        const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(url || '');
        if (!match || match[1].toLowerCase() !== repo.toLowerCase() || (n && Number(match[2]) !== n) || !issueNumber(match[2])) refuse('Ticket must be an issue in the board’s repo.');
        return `#${match[2]}`;
      };
      return {
        async link(id) {
          const n = issueNumber(id) || refuse('GitHub ticket must be an issue number such as #41.');
          const out = await call(['issue', 'view', String(n), '--repo', repo, '--json', 'number,url']);
          let issue;
          try { issue = JSON.parse(out); } catch { refuse('GitHub returned an invalid issue.'); }
          if (issue.number !== n) refuse('GitHub returned a different issue.');
          return inRepo(issue.url, n);
        },
        create: async ({ title, body }) => inRepo((await call(['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--assignee', '@me'])).trim()),
        async read(id) {
          const issue = JSON.parse(await call(['issue', 'view', id.slice(1), '--repo', repo, '--json', 'state,assignees']));
          const open = issue.state === 'OPEN';
          const assignees = issue.assignees || [];
          if (!assignees.length) return { open, assignee: 'none' };
          const login = (await call(['api', 'user', '--jq', '.login'])).trim().toLowerCase();
          return { open, assignee: assignees.some((a) => a.login?.toLowerCase() === login) ? 'mine' : 'other' };
        },
        assign: (id) => call(['issue', 'edit', id.slice(1), '--repo', repo, '--add-assignee', '@me']),
        comment: (id, body) => call(['issue', 'comment', id.slice(1), '--repo', repo, '--body', body]),
        async move(id, issue, target) {
          if (target === 'wontdo') {
            await call(['issue', 'close', id.slice(1), '--repo', repo, '--reason', 'not planned']);
            return { notPlanned: true };
          }
          if (target !== 'done') return null;
          await call(['issue', 'close', id.slice(1), '--repo', repo]);
          return {};
        },
      };
    },
  },
  linear: {
    targets: ['started', 'review', 'done', 'wontdo'],
    followsPRs: true,
    unreached: { link: 'Hub has no Linear key, so this board can’t create Linear tickets; add it in Hub › Integrations › Linear, or pick another ticket source.', move: 'Hub has no Linear key' },
    open(source, { linearFetch }) {
      const linear = savedClient({ fetch: linearFetch });
      if (!linear) return null;
      const me = linear.saved.viewer?.id;
      const refused = async (fn) => { try { return await fn(); } catch (e) { refuse(e.message); } };
      return {
        async link(id) {
          if (!ticketIn(source, id)) refuse(`Ticket must match ${source.team}-<number>.`);
          const issue = (await refused(() => linear.issue(id))) || refuse(`Linear has no issue ${id}.`);
          if (issue.team !== source.team) refuse(`${id} is in Linear's ${issue.team} team, not ${source.team}.`);
          return issue.identifier;
        },
        create: async ({ title, body }) => (await refused(() => linear.createIssue({ team: source.team, project: source.project, title, description: body, assignee: me }))).identifier,
        async read(id) {
          const issue = await linear.issue(id);
          if (!issue) throw new Error('Linear has no such issue');
          return { ...issue, open: !['completed', 'canceled'].includes(issue.state.type), assignee: !issue.assignee ? 'none' : issue.assignee === me ? 'mine' : 'other' };
        },
        assign: (id) => linear.assignIssue(id, me),
        comment: (id, body) => linear.commentIssue(id, body),
        async move(id, issue, target) {
          const state = await linear.moveIssue(issue, target);
          return state ? { state } : null;
        },
      };
    },
  },
};

// A card's legacy Linear links are read on any board, their source from the id's team.
const linkedSource = (id) => ({ source: 'linear', team: String(id).split('-')[0] });

// → {ticket, created}: links ticket, or makes one when it is undefined, assigned to the owner (cards.mjs keeps created
// as ticket_created, which moveTicket counts as the owner's). A source that can't be reached is refused, so a card
// never goes with a ticket it couldn't make
// (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).
export async function resolveTicket(source, { ticket, title, body = '', repo }, { run, linearFetch } = {}) {
  const provider = PROVIDERS[source.source];
  const calls = (await provider.open(source, { repo, run, linearFetch })) || refuse(provider.unreached.link);
  if (ticket === undefined) return { ticket: await calls.create({ title, body }), created: true };
  return { ticket: await calls.link(ticket), created: false };
}

// The id of a card named from its ticket: the ticket, or GH-<n> for issue #n, since a card id names files and branches.
export const cardIdOf = (ticket) => (ticket.startsWith('#') ? `GH-${ticket.slice(1)}` : ticket);

// The ticket a card's move asks for: a close → done, a build's start → started, a handover (a PR, a push, a verified
// merge-ready build) → review.
export function ticketTarget({ start, done, handover, wontdo }) {
  if (done) return wontdo ? 'wontdo' : 'done';
  if (start) return 'started';
  if (handover) return 'review';
  return null;
}

const TARGET_WORDS = { started: 'In Progress', review: 'In Review', done: 'Done' };

// docs/adr/2026-11-19-1430-a-ticket-moves-when-it-is-yours-and-says-so-in-its-thread.md
// Moves a card's ticket toward target, one way. → {kind, inputs} of the status line (hub-lines.mjs ticket-*) the move
// writes in the card's thread, or null when there is nothing to say. Never throws.
export async function moveTicket(source, item, target, ctx = {}) {
  if (!source || !target || !item.ticket || !ticketIn(source, item.ticket)) return null;
  const provider = PROVIDERS[source.source];
  // A pulled task's won't-do is the owner's call on an issue they chose to pull, whoever it is assigned to.
  const created = Boolean(item.ticket_created) || target === 'wontdo';
  if (!acts(provider, created, target)) return null;
  const failed = (why) => ({ kind: 'ticket-failed', inputs: { ticket: item.ticket, ...(target === 'done' ? {} : { to: TARGET_WORDS[target] }), why: String(why?.message || why).split('\n')[0] } });
  try {
    const calls = await provider.open(source, ctx);
    return calls ? await arbitrate(provider, calls, item.ticket, created, target) : failed(provider.unreached.move);
  } catch (e) { return failed(e); }
}

// A card's PR, or its commit landed on main, is announced once on its ticket, whoever the ticket is assigned to: a
// comment of one line, "<lead>: [<title>](<url>)" (docs/adr/2026-11-19-1600-a-tasks-pr-is-commented-on-its-ticket.md). → {kind, inputs} of the status line
// (hub-lines.mjs ticket-commented or ticket-failed), or null when the card has no ticket in the source. Never throws.
export async function commentTicket(source, item, { lead, title, url }, { repo, run = runRepo, linearFetch } = {}) {
  const ticket = item.ticket;
  if (!source || !ticket || !ticketIn(source, ticket)) return null;
  const provider = PROVIDERS[source.source];
  try {
    const calls = await provider.open(source, { repo, run, linearFetch });
    if (!calls) throw new Error(provider.unreached.move);
    await calls.comment(ticket, `${lead}: [${title}](${url})`);
    return { kind: 'ticket-commented', inputs: { ticket } };
  } catch (e) { return { kind: 'ticket-failed', inputs: { ticket, why: String(e?.message || e).split('\n')[0], comment: true } }; }
}

// The one assignee policy, for a card's move and the hub's PR poll alike: a ticket moves only when it is the owner's,
// one kickflip created (assigned to the owner at creation) or one assigned to the owner (the Linear key's viewer, or
// gh's user). A build's start makes an unassigned ticket the owner's first; at review or done an unassigned one stays as
// it is, with no line. A closed ticket never reopens. A source with no state for the target (a GitHub issue has no In
// Progress or In Review) only assigns, on start, so acts says whether it needs reading at all.
// → moveTicket's status line, or null
const acts = (provider, created, target) => provider.targets.includes(target) || (target === 'started' && !created);
async function arbitrate(provider, calls, ticket, created, target) {
  const moves = provider.targets.includes(target);
  const issue = await calls.read(ticket);
  if (!issue.open) return null;
  if (!created && issue.assignee === 'other') return { kind: 'ticket-left', inputs: { ticket } };
  const assign = !created && issue.assignee === 'none';
  if (assign && target !== 'started') return null;
  if (assign) await calls.assign(ticket);
  const moved = moves ? await calls.move(ticket, issue, target) : null;
  if (!moved) return assign ? { kind: 'ticket-assigned', inputs: { ticket } } : null;
  if (target === 'done' || target === 'wontdo') return { kind: 'ticket-closed', inputs: { ticket, ...moved } };
  return { kind: 'ticket-moved', inputs: { ticket, ...moved, assigned: assign } };
}

const POLL_REASONS = { done: 'Every task on it has merged.', review: 'Every task on it has merged or has a PR ready for review.', started: 'A task on it has a PR.' };

// docs/adr/2026-11-02-0023-the-hubs-poll-moves-the-owners-linear-tickets.md
// The hub's PR poll (hub/github.mjs checkGitHub) moves the tickets of each source whose tickets follow PRs, through
// arbitrate's policy. cards: [{source, item, key, card, scoped, failed, merged, ready, hasPR}], one per card on each
// board showing it, key naming the card once across those boards, card naming it for the audit log, and the rest its
// PRs as the poll read them: scoped when any was read, failed when any wasn't. A ticket is weighed across every card
// carrying it, its board's ticket and its legacy Linear links, and skipped unless one of its cards' PRs was read and
// none failed: a PR starts it, every card merged or ready for review puts it in review, every card merged closes it.
// A source the hub can't reach moves none. Each move and failure goes in the hub's audit log.
// → {moved: [{id, state}], failed: [message]}
export async function followPRs(cards, ctx = {}) {
  const result = { moved: [], failed: [] };
  const tickets = new Map();
  for (const { source, item, key, card, ...carrying } of cards) {
    const ids = (item.linear || []).map((id) => [id, linkedSource(id)]);
    if (ticketIn(source, item.ticket)) ids.push([item.ticket, source]);
    for (const [id, from] of ids) {
      if (!PROVIDERS[from.source].followsPRs) continue;
      if (!tickets.has(id)) tickets.set(id, { source: from, items: new Map(), created: false, cards: [] });
      const ticket = tickets.get(id);
      ticket.items.set(key, { ...carrying, failed: carrying.failed || ticket.items.get(key)?.failed });
      ticket.created ||= item.ticket === id && Boolean(item.ticket_created);
      ticket.cards.push(card);
    }
  }
  const opened = new Map();
  for (const [id, ticket] of tickets) {
    const items = [...ticket.items.values()];
    if (!items.some((item) => item.scoped) || items.some((item) => item.failed)) continue;
    const target = items.every((item) => item.merged) ? 'done'
      : items.every((item) => item.merged || item.ready) ? 'review'
      : items.some((item) => item.hasPR) ? 'started' : null;
    if (!target) continue;
    const provider = PROVIDERS[ticket.source.source];
    // The audit log keeps the poll's linear-move entries as they were named (bin/kickflip.mjs audit).
    const entry = { call: 'linear-move', key: id, reason: POLL_REASONS[target], inputs: { target, cards: ticket.cards, items } };
    try {
      if (!opened.has(provider)) opened.set(provider, await provider.open(ticket.source, ctx));
      const calls = opened.get(provider);
      if (!calls) continue;
      const line = await arbitrate(provider, calls, id, ticket.created, target);
      if (!line?.inputs.state) continue;
      result.moved.push({ id, state: line.inputs.state });
      audit(hubAudit(), { ...entry, result: `moved to ${line.inputs.state}` });
    } catch (e) {
      audit(hubAudit(), { ...entry, result: 'failed', reason: `${entry.reason} ${e.message}` }, { once: true });
      result.failed.push(`ticket ${id}: ${e.message}`);
    }
  }
  return result;
}
