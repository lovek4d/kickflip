# A block only keeps a card from In Progress

Card #499. The owner (11/09): "blocked by should not prevent grilling/prototyping, only moving to in progres". The only place a block stopped a planner was `arrivalsOf`, so a blocked card in Todo got no arrival grill until its deps finished. Owner's answers on the card: a `blocked_until` condition counts the same as a dep (t6-until); unblocked arrivals take the planner slots before blocked ones (t6-cap); a ready card does not build on its plan as it stands once unblocked, the orchestrator re-checks its notes first (t6-stale), and "Unblocking should have the orchestrator review if any of the questions have become stale and use the orchestrator choice answering mechanism"; no prototype round.

It supersedes [a blocked card is not grilled until its blockers land](2026-11-05-0200-a-blocked-card-is-not-grilled-until-its-blockers-land.md), and amends [an unblock past Todo waits on the orchestrator](2026-11-07-1500-an-unblock-past-todo-waits-on-the-orchestrator.md), where an unblock in Todo was record-only.

## Decision

- **A blocked card arrives.** `arrivalsOf` no longer skips a blocked card, by a dep or by a condition. The cap takes the unblocked arrivals first, then the blocked ones, each in board order; a bumped arrival still comes first. Rounds, staging, ready and the owner's Grill and Prototype taps never read a block, so the card grills, prototypes, stages and goes ready as any other.
- **The block still stops the build.** A blocked ready card is not `ready` and not pullable, its time line reads "blocked by …", and the Implement tap bumps it until it is unblocked, as before.
- **An unblocked ready card waits on a re-check.** When a ready card's block ends in Todo (the last dep's Done, `--blocked-until ""`, a wave block lifted), `markUnblocked` stores `recheck_at`, the ts of its "Unblocked" line. While it is set the card is neither ready nor pullable, and `orchestratorWaitOf` reads it as a `recheck` wait in Orchestrator review: re-read the notes and answered questions against what landed. `card-unblocked` is sent as before.
- **The re-check uses the screening path.** `question settle <id> --note` answers one of the card's questions again while it waits on a re-check, resolving it "Settled by the orchestrator: …" and writing the answer under an "Answers (orchestrator, …)" section in its notes, as a screened question is settled. A change too big to settle goes back with `item set --phase grilling`.
- **`item set --phase ready --text` releases it.** On a ready card with `recheck_at` it requires `--text`, writes it under "Re-checked (orchestrator, …)" in the notes, and clears `recheck_at`, so the pull takes the card. Any `--phase` clears it, and so does a build's start: the owner's Implement tap still starts the card at once, and a card that leaves Todo owes no re-check.
- **A card still planning when unblocked marks nothing.** It reaches staging after the unblock, and the orchestrator's staging judgment against the board is the re-check.

## Not done

- A hold's pick-up time is not a block and marks no re-check.
- Plan waves still leaves out blocked cards: it plans waves, not grills.

## Amended (2026-11-17)

A ready card whose block ends no longer waits on a re-check: it goes back to staging, where the staging judgment is the re-check, and `recheck_at` is gone ([a wait a block held is owed from the block's end](2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md)).
