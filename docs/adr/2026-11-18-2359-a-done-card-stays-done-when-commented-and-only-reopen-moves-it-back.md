# A Done card stays Done when commented, and only Reopen moves it back

Supersedes [a message or question on a Done card reopens it until the owner's Done](2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md), [a merged card reopens on a message](2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md) and, where it sends Reopen to Todo, [threads say Reply, with Hold, Resume and Reopen beside it](2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md).

The owner (T-566, card #1073): "a work item stays in done when commented, and only an explicit reopen puts it back". On where Reopen lands: "further work should be a new ticket, in review is just further discussion on that work item as is".

**A message or question on a Done card stays on a Done card.** `workItem` (`domain.mjs`) reads a card as reopened only from `reopened_at`; the owner's messages and questions after the close no longer set it, merged PR or not. The orchestrator still answers the message: a Done card's owner word, newest after its close, waits on it as a `reply` wait (`waitFactsOf` is given the close time on every card), and the settle pass leaves the stored Done card where it is.

**Reopen moves a Done card to In Review.** `recordOwnerTap` writes a "Reopened" status line, then moves the card to In Review with `reopened_at` and the thread line "Moved to In Review: you reopened it". Everything else about a reopened card is as before: it waits on the owner's Done once the orchestrator has answered, goes to In Progress once a builder starts on it, counts as finished for the cards waiting on it, and its ticket stays closed. Further work is a new ticket, not a reopen.

**A card stored in Todo with `reopened_at`**, which the old Reopen wrote, no longer reads as a reopened Todo card; it reads as the Todo card it is.

`item set --done` still refuses a card the owner reopened (`runs.mjs` `checkNotReopened`); it no longer refuses one that only has a message after its close, since that card is still Done.
