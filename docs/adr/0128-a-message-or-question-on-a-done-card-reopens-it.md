---
status: superseded in part by ADR-0131
---

# A message or question on a Done card reopens it until the owner's Done

Superseded in part by [0131](0131-the-cli-and-board-server-do-the-boards-housekeeping.md): the board server records a newer `card-done` in the wave file; the session doesn't.

An owner message in a Done card's thread, or a question Claude adds on it, reopens the card on the board with no step from the session. It sits in In Progress until Claude answers, then waits in In Review with Action needed until the owner presses Done. A merged card stays closed.

- **Derived, not written.** `workItem` in `board/domain.mjs` reopens a card whose status is done, by `--status done` or by a `card-done` tap still in force ([0106](0106-the-board-applies-the-owners-hold-resume-and-done-at-once.md)), when an owner `item-message` on it, or a question on its topic, is newer than that done mark. The board reads the card as having no status from then on. The wave file still says done, so monitor, the GitHub checks and `item set --status building`'s blocker check still treat it as finished, and on the board a reopened card blocks none of its dependents again ([0020](0020-cards-wait-on-explicit-blocked-by-links.md)).
- **Questions carry `asked_at`.** `question add` stamps every question it writes to `data/owner.json` with `asked_at`, which orders the question against the done mark. A question without one never reopens a card.
- **Lanes.** A reopened card is started, so it never goes to Todo ([0049](0049-a-started-card-never-returns-to-todo.md)). While an owner message or answer since the done mark has no Claude reply or later Claude line, Claude acts next and the card is In Progress. Once Claude has answered, the card waits on the owner's Done: In Review with Action needed, its next step "Tap Done once it is settled", and Mark as done as its action button, as an ask in progress has ([0035](0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md), [0045](0045-the-lane-follows-who-acts-next.md)). An open question puts it in In Review at once, with Open questions. A PR in review, a running builder or a new status from `item set` places it as on any card.
- **Closing again.** A newer `card-done` closes it, and the session records that with `item set --status done` as usual. The session doesn't close a reopened card on its own; a newer `--status done` would still close it.
- **Merged cards.** A card with status merged, `merged_at` or a merged or closed PR is never reopened. A message there still reaches the session, and `question add` refuses a question on it.

A question added to a Done card showed up on a closed card. Refusing it until the session reopened the card by hand made the session do a step the board can see for itself, and an owner message on a Done card left the card in Done while the conversation went on.

The owner asked for this on hub/INT-269: "anything with a message added at done automatically moves it to in progress until it either moves to in review or goes action needed to mark as done post answer".

Considered:
- the board server writing the wave file when it takes the message: a second writer of the wave file, which [0106](0106-the-board-applies-the-owners-hold-resume-and-done-at-once.md) turned down for the owner's taps;
- `question add` setting `--status building`, which needs the owner's go ([0124](0124-only-the-owner-or-auto-build-starts-a-card-run.md)), counts only while a builder runs, and would leave the card in In Progress with no Done to wait on;
- refusing a question on a Done card until the session reopens it, which round 1 of hub/INT-269 built.
