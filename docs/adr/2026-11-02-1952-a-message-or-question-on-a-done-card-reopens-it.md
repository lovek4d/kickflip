---
status: superseded in part by 2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping, 2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed, 2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state, 2026-11-09-1804-in-progress-means-a-builder-runs
---

# A message or question on a Done card reopens it until the owner's Done

Superseded in part by [the CLI and board server do the board's housekeeping](2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md): the board server records a newer `card-done` in the wave file; the session doesn't.

Superseded in part by [a merged card reopens on a message, and its PR badge shows the PR's state](2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md): a merged card reopens like a done card, and `question add` takes its topic.

Superseded in part by [a card waiting only to be closed has no Action needed](2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md): once Claude has answered, the card waits in In Review with no Action needed, keeps Grill, and its thread's Done is primary.

An owner message in a Done card's thread, or a question Claude adds on it, reopens the card on the board with no step from the session. It sits in In Progress until Claude answers, then waits in In Review with Action needed until the owner presses Done. A merged card stays closed.

- **Derived, not written.** `workItem` in `board/domain.mjs` reopens a card whose status is done, by `--status done` or by a `card-done` tap still in force ([the board applies the owner's Hold, Resume and Done at once](2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md)), when an owner `item-message` on it, or a question on its topic, is newer than that done mark. The board reads the card as having no status from then on. The wave file still says done, so monitor, the GitHub checks and `item set --status building`'s blocker check still treat it as finished, and on the board a reopened card blocks none of its dependents again ([cards wait on explicit blocked-by links](2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md)).
- **Questions carry `asked_at`.** `question add` stamps every question it writes to `data/owner.json` with `asked_at`, which orders the question against the done mark. A question without one never reopens a card.
- **Lanes.** A reopened card is started, so it never goes to Todo ([a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md)). While an owner message or answer since the done mark has no Claude reply or later Claude line, Claude acts next and the card is In Progress. Once Claude has answered, the card waits on the owner's Done: In Review with Action needed, its next step "Tap Done once it is settled", and Mark as done as its action button, as an ask in progress has ([an ask can wait on the owner before Done, and the owner closes any open card from its thread](2026-10-29-1639-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md), [the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md)). An open question puts it in In Review at once, with Open questions. A PR in review, a running builder or a new status from `item set` places it as on any card.
- **Closing again.** A newer `card-done` closes it, and the session records that with `item set --status done` as usual. The session doesn't close a reopened card on its own; a newer `--status done` would still close it.
- **Merged cards.** A card with status merged, `merged_at` or a merged or closed PR is never reopened. A message there still reaches the session, and `question add` refuses a question on it.

A question added to a Done card showed up on a closed card. Refusing it until the session reopened the card by hand made the session do a step the board can see for itself, and an owner message on a Done card left the card in Done while the conversation went on.

The owner asked for this on hub/INT-269: "anything with a message added at done automatically moves it to in progress until it either moves to in review or goes action needed to mark as done post answer".

Considered:
- the board server writing the wave file when it takes the message: a second writer of the wave file, which [the board applies the owner's Hold, Resume and Done at once](2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md) turned down for the owner's taps;
- `question add` setting `--status building`, which needs the owner's go ([only the owner or Auto-build starts a card run](2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md)), counts only while a builder runs, and would leave the card in In Progress with no Done to wait on;
- refusing a question on a Done card until the session reopens it, which round 1 of hub/INT-269 built.

Superseded in part by [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): a reopen is stored as a move out of Done with reopened_at; a Done card whose PRs all closed unmerged doesn't reopen.

Superseded in part by [In Progress means a builder runs](2026-11-09-1804-in-progress-means-a-builder-runs.md): a reopened card waits in In Review, its Next "Your reply waits on the orchestrator" until Claude answers, and goes to In Progress only once a builder starts on it.

Superseded in part by [threads say Reply, with Hold, Resume and Reopen beside it](2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md): a Done card's thread has Reopen beside Reply; Reopen moves it back to Todo, discussing, and a Reply still reopens it as above.
