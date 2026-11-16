# The hub page has one New strip for routed requests and incoming asks

The hub page's Routed section becomes **New**: the board's own New strip (`BoardUI.newStrip`), listing everything that
arrived at the hub, newest first. A row source is a mapper in `hub/router.mjs routedRows`, drawn by one row kind in
`ui-cards.js`, not a section of its own.

- Routed requests (Slack, handoff, the hub box) read "Routed to / Added to / Moved to" as before.
- An incoming board ask ([a board asks another board](2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md))
  reads "Asked /<answering board>" linking its entry there, then `queued`, or `Answered` linking the asking card,
  where the answer landed as a message. A muted line names the asking board and card. An answered ask has no link
  when it was asked from no card.
- Asks come from each board's own events file (`boardAsksOf`), so there is no second store.
- Cross-hub asks (T-389) add their own mapper when they land.

Rejected: a separate Asked section; it would repeat the strip's markup for a second list of the same shape.
