// docs/adr/2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md
// Text that leaves the board (a PR's title and body, a commit message, a PR or review comment, a Slack post, a ticket's
// body) cites earlier work only by what outside readers can open: its ticket, its PR, its landed commit. A task key
// (T-12, an old INT-3) is the board's own, and work that never left the board isn't cited at all.
//
// tasks are the board's cards, open and archived: [{key, id, ticket, prs: [{repo, number}], landed}], id the card's
// internal key (T-12), ticket its ticket from the board's source or null, prs cardPRs', landed its landed commit's sha.

// A token shaped like a card key, a word of capitals, a dash and a number, with its board file when given (hub/T-12),
// and not inside a URL or a longer word.
const KEY = /(?<![\w/#.-])(?:[a-z][\w-]*\/)?([A-Z][A-Z0-9]*-[1-9]\d*)(?![\w-])/g;

// The task's external form: its ticket with its PR ("#12, PR #15"), else its PR, else its landed commit, else null when
// nothing of it left the board. repo is the board's GitHub repo, whose PRs read "#n" and others' "owner/name#n".
export function externalRef(task, repo) {
  const prs = (task.prs || []).map((p) => (p.repo && p.repo !== repo ? `${p.repo}#${p.number}` : `#${p.number}`));
  const pr = prs.length ? `PR ${prs.join(', ')}` : null;
  if (task.ticket) return pr ? `${task.ticket}, ${pr}` : task.ticket;
  if (pr) return pr;
  return task.landed ? `commit ${task.landed.slice(0, 7)}` : null;
}

// The tasks texts name by their internal key, each once, in the order first named: a key no card holds (a quoted
// example such as "T-123") isn't one.
function named(tasks, texts) {
  const byId = new Map(tasks.filter((t) => t.id !== t.ticket).map((t) => [t.id, t]));
  const found = new Map();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const m of t.matchAll(KEY)) if (byId.has(m[1]) && !found.has(m[1])) found.set(m[1], byId.get(m[1]));
  }
  return [...found.values()];
}

// Why texts can't leave the board, naming each task key in them and what to cite instead, or null when they can.
export function citeFault(tasks, texts, repo) {
  const cited = named(tasks, texts);
  if (!cited.length) return null;
  const each = cited.map((t) => {
    const ref = externalRef(t, repo);
    return ref ? `cite ${t.id} as ${ref}` : `leave ${t.id} out, as it never left the board`;
  });
  return `the text leaves the board, where a task key means nothing: ${each.join('; ')}. Outside text cites only tickets, PRs and commits`;
}

// text with each task key in it written as its external form, and a task that never left the board as "an earlier
// task": for a ticket's body made from a card's notes, which are the board's own and so rendered, not refused.
export function renderCites(tasks, text, repo) {
  const byId = new Map(named(tasks, [text]).map((t) => [t.id, t]));
  return text.replace(KEY, (whole, id) => (byId.has(id) ? externalRef(byId.get(id), repo) ?? 'an earlier task' : whole));
}
