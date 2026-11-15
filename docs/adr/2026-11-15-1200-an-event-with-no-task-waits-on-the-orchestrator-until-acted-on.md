# An event with no task waits on the orchestrator until acted on

#769 (hub/T-392), split from T-299 ("should the orchestrator work from a queue so the app never waits on it?"). The owner: "Nothing is lost or forgotten", and an event with no card should stay queued: "Yes: each waits until its command runs". A task's events already wait through its card's orchestrator wait, and an overnight triage through `triageWaitOf`. Four kinds counted as handled once the watcher printed them, so a session that died mid-turn dropped them: `pr-review`, `review-answer`, `arch-review` and `slack-question`.

- **The waits.** `domain.mjs eventWaits` reads them from the event log, in event order, each keyed by its event id with its kind as the wait's kind. `board/server.mjs stepWaits` lists them on `data/orchestrator-waits.json` after the cards' waits and the triage, so they share `waitsStep`'s wake, its 15-minute re-wake, and the wait list each wake prints.
- **What clears each.** The wait holds until the command that acts on it has left its record:
  - `pr-review` and `review-answer`: `review post` or `review record` records the PR again. This is the reviewing rule the Auto Review lane already used, now one helper (`auto-review.mjs pendingReviewAsks`). A PR the hub stops listing ends its wait, since there's nothing left to review.
  - `arch-review`: its audit task asks a question (the findings, in one `question add`) or closes. An audit task gone from the board ends it.
  - `slack-question`: `slack answer`, `slack task` or the new `slack skip` (a thanks, posting nothing) appends a record-only `slack-handled {id, by}`. For a message that expects no reply (`answer: false`), `slack thread` reading it appends one.
- **Pushes.** None: no wait pushes the owner, an event's included ([Tap Done and orchestrator-wait reminders do not push](2026-11-15-1500-tap-done-and-orchestrator-wait-reminders-do-not-push.md)). The wait's `link` (`#review=<pr>` for a review, the audit task for an architecture review, the board for Slack) stays on the wait.
- **Never picked.** The watcher doesn't mark these events working. On an event no task holds, a working mark reads Working on it until a reply file exists (`buildBoard workingOn`), and the Stop hook would then hold the turn open for a reply none of these takes. Each wait stays unpicked: it re-wakes every 15 minutes until its command runs.
- **Display.** Each wait's ref is plain words, not a card ref: `PR #12`, `Slack · Ann`, or the audit task's ref. That's what T-393's header count lists.

Considered:
- Adding the four kinds to `WORKING_KINDS` for an hourly re-wake once picked up, as a triage gets. The mark would leave them working forever on the page and block the session's Stop with "answer with board.mjs reply", so it's out.
- Clearing a `slack-question` on `slack thread` alone. Reading isn't acting: a session that died between reading and answering would lose it, which is the gap this closes.
