// docs/adr/2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md
// Pull in issues: on a board whose Pull in issues is assigned or all (board/settings.mjs settingsOf pull_issues), the hub's
// GitHub poll files each open issue on the board's repo that no task names as a discussing GH-<n> task, and wakes the
// orchestrator to sort it. The issues ride the poll's one GraphQL query (pr-report.mjs fetchPRs), its newest
// ISSUES_LISTED per repo.
import { fetchPRs, ISSUES_LISTED } from './pr-report.mjs';
import { appendEvent, listBoards } from './boards.mjs';
import { appendStatus, fileIssues, namedTickets } from '../board/cards.mjs';
import { overridesOf, readBoardJSON, storedTickets } from '../board/settings.mjs';

// The repo a board can pull issues from: its own, while its ticket source is GitHub and its tasks live in one item file.
// → owner/name, or null
export function issueRepo(board) {
  if (board.kind !== 'file' || storedTickets(board.tickets)?.source !== 'github') return null;
  return board.github || board.files[0]?.itemFile.repo || null;
}
// The repo the poll lists issues of for board: issueRepo while its Pull in issues is on. → owner/name, or null
export const pullRepo = (board) => (board.pullIssues === 'off' ? null : issueRepo(board));

// The owner, whose issues Assigned only keeps: the ticket source's gh account, else the board's GitHub login, else
// login, the account the poll's query ran as; the ticket layer's assignee rule reads the same one (board/tickets.mjs).
const ownerOf = (board, login) => storedTickets(board.tickets)?.account || board.githubLogin || login || null;

// nodes: the query's open issues, newest first. mode: off | assigned | all; me: the owner's login; since: an ISO time, or
// null; named: the tickets tasks name (board/cards.mjs namedTickets). → the issues to file, oldest first: each no task
// names, created after since, and with assigned, assigned to me.
export function issuesToPull(nodes, { mode, me, since, named }) {
  if (mode === 'off') return [];
  const mine = (issue) => Boolean(me) && (issue.assignees?.nodes || []).some((a) => a.login?.toLowerCase() === me.toLowerCase());
  return nodes.filter((issue) => !named.has(`#${issue.number}`) && (!since || issue.createdAt > since) && (mode === 'all' || mine(issue))).reverse();
}

// One poll's pull onto board. listed: fetchPRs's issues; login: the query's viewer. Each task it files gets a
// first line and an issue-pulled event. → the keys filed
export async function pullIssues(board, listed, login, failed) {
  const repo = pullRepo(board);
  if (!repo || !listed[repo]) return [];
  const me = ownerOf(board, login);
  const { filed, failed: refused } = await fileIssues(board.dir, board.files[0].slug,
    (named) => issuesToPull(listed[repo].nodes, { mode: board.pullIssues, me, since: board.pullSince, named }));
  for (const why of refused) failed.push(`${board.route}: ${why}`);
  for (const { key, issue } of filed) {
    const ticket = `#${issue.number}`;
    try {
      await appendStatus(board.dir, key, 'issue-pulled', { ticket });
      await appendEvent(board, 'issue-pulled', { key, ticket, title: issue.title, url: issue.url });
    } catch (e) { failed.push(`${board.route}: could not tell the orchestrator of ${key} (${e.message})`); }
  }
  return filed.map((f) => f.key);
}

// The backlog ask's count: how many open issues turning board's pull on in mode would file now, of the newest
// ISSUES_LISTED. → {count, more: whether the repo holds more open issues than were listed}, or null for a board that
// can't pull. Throws when GitHub can't be read.
export async function issueBacklog(board, mode) {
  const repo = issueRepo(board);
  if (!repo) return null;
  const query = await fetchPRs([], [], [repo]);
  const listed = query.issues[repo];
  if (!listed) throw new Error(`GitHub did not list ${repo}'s issues`);
  const count = issuesToPull(listed.nodes, { mode, me: ownerOf(board, query.login), since: null, named: await namedTickets(board.dir) }).length;
  return { count, more: listed.total > ISSUES_LISTED };
}

// Hub settings' backlog ask, for Pull in issues' Board default turned on in mode: issueBacklog summed over each board that
// takes the default and can pull. → {count, more, boards: [route]}, or null when no such board.
export async function defaultBacklog(mode, boards = listBoards()) {
  const out = { count: 0, more: false, boards: [] };
  for (const board of boards) {
    if ('pull_issues' in overridesOf(await readBoardJSON(board.dir))) continue;
    const backlog = await issueBacklog(board, mode);
    if (!backlog) continue;
    out.count += backlog.count;
    out.more ||= backlog.more;
    out.boards.push(board.route);
  }
  return out.boards.length ? out : null;
}
