# A PR links only through the board's own branch name

From #1050. Two boards on one repo each number their tasks, so both can have a T-19. The poll's hand-opened PR link (`hub/github.mjs` `linkHandPRs`) matched a bare card id as the PR's head branch, so another board's PR on a branch named T-19 was pinned to this board's T-19.

- **What links now.** An open same-repo PR links to a card only when its head is the card's board-named branch, `board/worktree.mjs` `boardBranch` (`<user>/<board>/<ticket>`, the name a build pushes; `branchName` is its lookup by site). A bare card id links nothing.
- **Why drop the bare name.** Builds stopped pushing bare card ids with docs/adr/2026-11-18-1220-builder-branches-are-named-by-user-board-and-ticket.md; the match was a leftover.

Considered:
- also linking by a `Refs: <board>/<T-N>` commit trailer: the poll's one GraphQL query lists only `number headRefName isCrossRepository`, so a trailer needs a per-PR commit read; left out.
