# Builders run only their own tests; the land runs affected once

Status: accepted (owner's answer t321-shape, "Quick gate, then full affected", 11/13; T-210 folded in by t321-fold, 11/13)

Supersedes the builder half of [lands and builders run only the tests a change affects](2026-11-12-2104-lands-and-builders-run-only-the-tests-a-change-affects.md)
(a builder ran the affected set before hand-back), the "testing is the full suite" bar of
[the fourth bar is review](2026-11-04-2345-the-fourth-bar-is-review-and-the-finish-sets-landing.md), the five bars of
[a building card shows its phase as five bars](2026-11-03-0458-a-building-card-shows-its-phase-as-five-bars.md), and
T-210's same-tree choice (the builder runs the suite, the land reruns it only if the rebase changed the tree), which was
never built.

## Decision

- **A builder runs only its own tests, as part of building.** `board.mjs test --dir <worktree> --base <base>` runs the
  test files the change adds or edits since its merge base, committed, uncommitted or untracked (affected.mjs
  `ownTests`), and none other. With none it says so and passes. Its status line reads under building.
- **The land rebases once and runs the affected set once.** `builder done` (finish.mjs, worktree.mjs `prepareLand`)
  rebases onto the base and runs `affectedTests`, as before. A failure goes back to the builder; T-325's rerun of an
  untouched failing test on main still applies. On a PR board, `builder done` runs the affected set before the push.
- **No testing step.** In Progress's steps are reading, building, checking, landing: four bars. A builder's tests are
  part of building, the land's run part of landing. `builder progress --phase testing` is refused like any unknown
  phase. A status line written in the old testing step reads as building (domain.mjs `stepOf`), so a card mid-build when
  this lands keeps a valid step and the settle pass never writes a gone phase.
- **The briefs.** The builder brief has the builder run only the tests it writes or changes, with `board.mjs test`, and
  not rebase before it finishes. The finish steps say done rebases once and runs the affected tests once; after a
  conflict the builder resolves, it runs done again with no test run of its own. The PR rebase run's brief drops its own
  affected run: its `builder done` runs it before the push.

## Why

Under parallel builds the base moves under almost every card, so a builder's affected run before hand-back was followed
by the same run again after the land's rebase. The owner: "the full test (and perhaps any test) should not happen when
there is a known pending rebase that will require running it again. Maybe only run tests built as part of that ticket
pre rebase, as part of the building loop rather than a true testing step." The builder's own tests are the quick gate;
the land's run, after the one rebase, is the full one.

## Kept

A land whose base moves while it tests still rebases and tests again before the fast-forward
([a Merge tap waits its turn to land](2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md)): only the fast-forward
holds the land lock, and holding it through the tests would make every land wait for the others' runs.
