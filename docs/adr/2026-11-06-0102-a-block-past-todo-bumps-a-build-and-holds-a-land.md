# A block past Todo bumps a build and holds a land

Card #362. A block (an unfinished dep or a `blocked_until` condition) used to count only in Todo. Nothing past Todo read it: a builder kept running, and `builder done`, `land`, `merge`, auto-merge and the Merge tap never checked it. Owner's answers on the card (11/06): a card blocked In Progress goes back to Todo, its builder stopped, keeping its branch and worktree, and starts again once unblocked; a card blocked In Review stays but can't land, and "Just disable merge button don't hide, blocked by n tooltip"; a block never silences a wake; no prototype round.

## Decision

- **Blocked In Progress, back to Todo.** `item set --deps` or `--blocked-until` that leaves a started card blocked, while it has no PR, pushed branch or held Merge, clears its status and closes its build records, so the card is unstarted again. Before writing, its board-launched builder, lander or rebase run stops as `builder stop` stops it (`stop.mjs stopForBlock`), with the stop's thread line; one whose process is already gone has nothing to stop. The thread then reads "Blocked by #53: back to Todo. It starts again once nothing blocks it." The worktree and branch stay on the closed records and the card keeps its state, so the pull starts it again once a dep finishes or the condition is cleared.
- **A session's own builder is refused.** The board can't stop a builder it didn't launch, so the block is refused and nothing changes; the error says to finish or stop it in that session (`builder done --next`) first.
- **Blocked In Review, held.** A card with a PR, pushed branch or held Merge stays where it is. `merge` refuses it ("Not merged: blocked by #53.") before asking GitHub, which auto-merge's tick treats as a quiet refusal; the Merge tap on a held branch is refused; `land` and `builder done` refuse the land itself once it would happen (Auto-merge on, or a tapped Merge), and with Auto-merge off still verify and hold the build; `store.mjs landable` skips a blocked card, so no lander starts.
- **The Merge shows disabled.** A blocked card that would show Merge has no Action needed, reads Next "Merges once unblocked", and its Merge button is disabled, its tooltip "Blocked by #53 and until <condition>" (`domain.mjs mergeBlocked`). Its time line already read the block.
- **Wakes are untouched.** A block never silences a wake. A finishing dep already sends `card-unblocked` to an In Review card, whose status is unset.

## Not done

- A blocked card with a PR whose fix builder is running is not stopped: it is In Review for the block, and only its land is held.
- No UI to add a block; the owner and orchestrator block through `item set`.
- Phase changes in Todo are as [a blocked card is not grilled until its blockers land](2026-11-05-0200-a-blocked-card-is-not-grilled-until-its-blockers-land.md) left them.

Superseded in part by [a card pause stops its builder at its next stopping point](2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md): a card blocked In Progress pauses its build there instead of going back to Todo, and a session's builder is paused rather than refused.
