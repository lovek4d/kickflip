# A failed ticket move is retried on the hub's poll, and an untagged release offers its tag

Card #1149 (T-799). Two gaps seen on 11/19. T-794's Done failed to close #1120 on a network error ("TLS handshake
timeout") and nothing tried again, so the issue stayed open. T-770 and T-795 (0.23.0, 0.23.1) landed with the board's
Run release script box off: the land stopped short of the tag, the card read `publishing` as if a run was coming, and
the orchestrator had to notice and offer the ship command by hand.

Builds on [a ticket moves when it is yours and says so in its thread](2026-11-19-1430-a-ticket-moves-when-it-is-yours-and-says-so-in-its-thread.md)
and [a release card waits in In Review until its release is published](2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md).

## Decision

- **A failed ticket move is kept.** A card's move of its ticket that comes back `ticket-failed` stores the target it
  asked for on the item as `ticket_retry` (board/cards.mjs keepTicketRetry). A later move of that ticket that went
  through, or needed nothing, clears it.
- **The hub's poll retries it** (hub/ticket-retry.mjs, from hub/github.mjs checkGitHub, on the poll's cadence with no
  timer of its own) through the same `moveTicket` and its assignee policy. Success writes the usual `ticket-closed` or
  `ticket-moved` line and clears the mark. Another failure writes nothing, so the thread keeps its one red line and the
  next poll tries again. A Done retry for a card that has since left Done is dropped.
- **A release landed with Run release script off is `untagged`.** When the board pushes main but the box is off, the
  land stores the card's release with state `untagged`, the card reads `waits on tag v<X>` in orange, and its thread
  gets a Run card: the release script's `check` then `ship` for the landed commit, run from the repo after a fetch. The
  release watch keeps `untagged` until the tag shows a run, then reads it as `publishing` as before. With main not
  pushed, the land ships nothing either way and the card reads `publishing` as it did.

## Considered

- **Retrying on its own timer.** The poll already runs on the hub's cadence and every other watch rides it.
- **Closing the issue from the land's own retry loop.** The land has finished and returned by then; the poll is the
  one process that outlives it.
