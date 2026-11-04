# A build remakes a leftover worktree that holds no work instead of refusing

#109's first build made `worktrees/GH-109` from main and stopped before any commit (the card went back to prototyping). The worktree stayed, clean. Hours later the owner's Build tap refused: "--worktree: …/GH-109 already exists; land or remove it first", and the owner asked on the thread "Why is this happening and why can't you fix it yourself?" The orchestrator removed it by hand and built again. [0064](0064-every-builder-works-in-a-worktree.md) had `builder start --worktree` refuse any existing path.

- **No work, remade.** When the card's worktree path holds a git worktree of the board's repo on the card's branch, with no commits beyond the base the build branches from (`refs/heads/main`, or the board's fetched branch) and nothing in `git status --porcelain`, `board/worktree.mjs` `makeWorktree` removes it (`--force`, which takes ignored files such as `node_modules`) and deletes the branch, then makes it fresh from the current base. Both `builder start --worktree` and the Build tap (`startTappedBuild`, `startQueuedBuild`) go through it.
- **It says so.** `startBuilder` prints "Remade the leftover worktree <path> from <base>: it held no commits or changes." after the `worktree:` line and appends it to the card's thread.
- **Work still refuses, named.** A worktree holding work refuses with what it holds: "--worktree: <path> holds 2 commits beyond main and 1 changed file; land or remove it first".
- **An open builder's worktree is not leftover.** When another open (not done) builder record on the card keeps that worktree, the start refuses with "already exists and another open builder record uses it". The record the start writes over (a tapped or dispatched one it takes up) is not another.
- A path that isn't the repo's worktree on the card's branch refuses as before ("already exists"), since nothing says what it holds.

Considered:
- reusing the leftover worktree as it stands: it branches from an older main, and a later land would rebase work onto a base the builder never saw;
- remaking only from the Build tap: the session's `builder start --worktree` hits the same leftover after a stopped build.
