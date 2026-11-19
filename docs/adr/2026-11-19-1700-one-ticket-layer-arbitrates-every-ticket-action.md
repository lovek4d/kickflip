# One ticket layer arbitrates every ticket action

Builds the seam the owner asked for on T-552 ("a seam between ticketing types … to arbitrate (gh vs linear vs
internal)") and settled on T-781: "The hub shouldn't be calling it advanceLinear. I'm thinking more a single abstract
layer that internally does what is needed."

- **One module.** `board/tickets.mjs` is the only code that reaches GitHub or Linear for a ticket. Board and hub call
  its verbs: `resolveTicket` (link or create), `moveTicket` (a card's start, handover or close) and `followPRs` (the
  hub's PR poll). `board/ticket-paths.test.mjs` fails if another module runs `gh issue` or calls a Linear issue.
- **One provider per source.** Each source (GitHub, Linear) is a provider with the same calls: link, create, read,
  assign, move. With no source, a card is a task and has no provider. A provider also says which targets it has a state
  for (a GitHub issue has only closed) and whether the hub's PR poll moves its tickets.
- **One policy.** `arbitrate` holds the assignee rule of
  [a ticket moves when it is yours](2026-11-19-1430-a-ticket-moves-when-it-is-yours-and-says-so-in-its-thread.md)
  once, for a card's move and the poll alike. So the poll now assigns an unassigned ticket to the owner when a PR
  starts it, as a build's start does, and a card's own move is one way on Linear too: a ticket in review is never moved
  back to In Progress by a rebuild.
- **The poll weighs cards, the layer moves tickets.** `hub/github.mjs` hands the layer each card with its PRs as the
  check read them (`ticketCards`); the layer gathers each ticket's cards, picks the target as
  [the hub's poll moves the owner's Linear tickets](2026-11-02-0023-the-hubs-poll-moves-the-owners-linear-tickets.md)
  set out, and moves it through the policy. Its result is the check's `tickets`, logged by the hub as `ticket:` lines.
  The audit log keeps the `linear-move` name.
- **GitHub issues don't follow PRs.** An issue has no In Progress or In Review, a build's start already assigns it,
  and a merge closes its card, which closes it. Reading every carried issue on each check would only spend GitHub's
  rate limit.
- **Ids stay in the layer.** A branch's ticket part (`ticketSlug`) and a card's legacy Linear links (`linkedTickets`)
  come from it, not from `source === 'github'` branches in `worktree.mjs` and `domain.mjs`.

Left where they are, since they are not ticket actions: choosing a source and its prerequisites (Board settings, a new
board, `fallBackFromLinear`, `board-repo.mjs`), the Linear key and project routes on the hub, the pages' labels, and
`refuseUnplaced`, a GitHub board's rule that an ask place each issue it names.

Considered:
- wrapping `advanceLinear` in the layer: the owner asked for it to go, and it kept a second copy of the policy;
- one call per card from the poll: a ticket on several cards would move on the first card's PR, against the poll's
  every-card rule.
