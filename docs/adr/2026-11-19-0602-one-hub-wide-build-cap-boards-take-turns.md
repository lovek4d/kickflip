# One hub-wide build cap, boards take turns

Status: accepted (owner's answers t749-caps "Both caps move to the hub; boards keep no limit", t749-turns "Strict
rotation, one card per board per turn", t749-board-rows "Remove the rows; caps live only in hub settings", t749-split
"Split as proposed", 11/18; the Hub page visual confirmed with Implement)

Card #1092 (T-749). The owner: "would like to move the max parallel etc settings to the hub level. will need some top
from each board queue to rotate capacity round robin style", and "i would like it to be removed from the usage section
into a new section right below it".

Supersedes, in where the number lives and who shares it, [auto implement fills In Progress up to a cap](2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md)
and [the implementer limit counts cards In Progress](2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md),
whose counting rules stand. Amends [models and land tests are hub settings only](2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md)
in where Maximum parallel land tests is drawn.

## Decision

- **Maximum tasks in progress is one hub number.** `settings.json` `tasksInProgress`, 1 to 99, 5 unless set
  (`hub-settings.mjs readTasksInProgress`), counts the cards In Progress across every board on the host, each card as
  `domain.mjs pullOf` counts it today. Near the usage line it is halved as before (`usage-gate.mjs tasksInProgressCap`).
  Board Settings has no Maximum tasks in progress row, the board's `api/settings` and `settings set max-implementers`
  are gone, and a board's old `max_implementers` key is ignored and dropped by its next settings save. No per-board
  value is carried over: the hub number starts at 5.
- **Boards take strict turns at the free slots.** Each board server writes its entry in `~/.claude/kickflip/builds/`,
  a file per board: the slots it holds, the cards it wants in its own pull order (bumped first, then blockers of an In
  Progress card, then Todo's order), and the cards granted to it (`board/build-turns.mjs`). On each Auto pass the board,
  under the builds lock, takes the cards granted to it that it still wants, then hands the free slots out
  (`turnsOf`): bumped cards first, the earliest bump first whichever board it is on, then round the boards in order of
  their site folder from the one after the last served, one card each per turn. A board with nothing ready gives its
  turn up. It starts its own share at once and writes the others' grants into their entries; a board whose entry gains
  a grant runs its pass (a watch on the folder, and the minute check as a fallback, which also catches a raised
  number). `builds/turn.json` remembers the last board served.
- **A bump jumps the turns and never stops running work** (T-744's rule): it takes the next free slot, moving no turn.
- **A board whose server is gone holds no slot.** An entry counts only while its process lives, and a closing server
  removes its own.
- **The Hub page has a Capacity section right below Usage**: Maximum tasks in progress, then Maximum parallel land
  tests, which leaves Usage's Claude block. Each posts its own route (`/_hub/settings/tasks-in-progress`,
  `/_hub/settings/land-tests`).

## Consequences

- One busy board no longer fills its own five slots while others wait: three boards with ready cards each get one of
  every three free slots in turn.
- A slot granted to a board waits for that board's pass to take it; a granted card that is no longer pullable there is
  dropped and its slot goes on to the next turn.
- Maximum parallel serves stays per board until the serves task moves it into the Capacity section; land test slots
  and the land lock keep their own queues until T-754 puts every hub limit on these turns.
