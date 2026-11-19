# The hub's poll moves the owner's Linear tickets

The hub's GitHub poll advances Linear tickets through Hub's saved Linear key after saving its GitHub results. The session and optional monitor tick leave these PR-based moves to the hub. Without a key the poll makes no Linear requests and moves none. This supersedes [the hub reads GitHub itself](2026-11-01-2314-the-hub-reads-github-itself.md) in part; [kickflip reaches Linear with a key on the Mac](2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md)'s `item set` moves stay as they are.

A card carries its `linear` identifiers on every board, plus `ticket` when the board's ticket source is Linear. Tickets on cards whose PRs were fetched successfully are considered across every carrying item on every board, counting a waves item once by its source and ignoring dropped cards. Any failed PR fetch on a carrying item skips that ticket for this check. A draft or ready PR starts work; every unmerged item ready for review means In Review; every item merged or done means Done. A closed, unmerged PR counts as not started.

Each ticket is read once per check. Only an issue assigned to the saved key's viewer, or held as a kickflip-created `ticket`, moves. Its current Linear state determines whether the target is ahead: backlog, triage and unstarted precede started, then review, then completed or canceled. The team's states are looked up only for a forward move; a missing review state is a skip. Reading the issue each check respects changes made directly in Linear and makes unchanged polls idempotent.

Linear moves and failures have their own poll result. Moves are logged; failures are logged at most hourly with their own timestamp and never make a successful GitHub check look unreachable. Linear failures never discard the saved GitHub results.

Amended by [one ticket layer arbitrates every ticket action](2026-11-19-1700-one-ticket-layer-arbitrates-every-ticket-action.md): the poll hands its cards to `board/tickets.mjs` `followPRs`, which moves each ticket through a card's move's assignee rule, so a PR starting an unassigned ticket assigns it to the owner; the result is the check's `tickets`.

Considered:
- leaving it to monitor: an optional skill would still own a step needed on every board;
- moving only `item.ticket`: existing `linear` links would be missed;
- remembering the last target in `github-state.json`: it would miss state and assignee changes made directly in Linear.
