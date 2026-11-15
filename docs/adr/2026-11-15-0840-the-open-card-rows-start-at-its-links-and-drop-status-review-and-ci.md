# The open card's rows start at its links and drop Status, Review and CI

Card #759 (hub/T-382) audited the open card's data rows (`detail()` in `board/public/app-cards.js`) against what the card face, its lines and its footer already show. The owner chose state first, dropping the rows that repeat the face, and hiding every empty row (t382-g1-order, t382-g1-repeats, t382-g1-empty), then take A of prototype `card-rows`: the face chips stay as they are (card-rows-r1).

## Decision

- **No Status, Review or CI row.** The face carries the card's state (its builder, planner, land or orchestrator line, the footer's phase word), its reviewers (the reviewer chips) and its CI (the PR badge). `statusWord` in `ui-cards.js`, which only the Status row read, is gone.
- **The order**: Parent, Children, Related to, Blocked by, Blocks, then Risk, Merge, Branch (or Commit), Manual steps, Next, and the Links line.
- **Merge** shows an open PR's merge state alone, lowercased ("blocked", "clean"); the review decision went with the Review row. A PR whose merge state isn't read yet draws no Merge row, never "unknown".
- **Blocks** replaces Waits on it: the cards that name this one as a dep.
- **Once a blocker, always a blocker.** Blocked by lists every dep on the board (`blockers` in `board/domain.mjs`), a Done one with its done lane ring, on an open card and a Done one alike; Blocks is its mirror. The footer's "blocked by" and everything the block gates still read `blockedBy`, the deps not yet Done.
- **Every empty row is left out**, as before.

## Consequences

- On a phone, which can't open the PR badge's tooltip, the CI words no longer show in the open card; the badge's colour and mark still say pass, pending or failing ([a PR's one badge](2026-11-14-1600-a-prs-one-badge-shows-draft-ready-by-ci-or-merged.md)).
- A Done blocker that the board has archived drops out of Blocked by, as any card off the board drops out of a link row.

This supersedes the Status row of [a card's status word comes from a signal the board checks](2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md), and the Waits on it row and the "Blocked by lists only the deps not yet Done" of [a follow-up is a work card with a Parent](2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md).
