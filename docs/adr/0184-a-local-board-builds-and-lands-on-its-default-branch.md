# A local board builds and lands on its default branch

This supersedes in part [0143](0143-kickflip-join-adds-the-current-repository-as-a-board.md), on the branch a local board builds from and lands on.

#81 came out of #53's grill: a local board assumed its branch was called `main`. Builders branched from `main`, `land` refused unless the folder was on `main` and fast-forwarded it, and the Main card built `main`. On a repo whose branch is `master`, `trunk` or `develop`, the first Build failed with "has no main branch". Join already saved a `branch`, but nothing read it. The owner settled it on #81 (11/03).

- **Join records the default branch.** Bare `kickflip join` saves the folder's default branch as `branch`: origin's (`git symbolic-ref refs/remotes/origin/HEAD`), else the checked-out one, since the folder may be on a feature branch (`hub/repos.mjs` `defaultBranch`, which the `board-github` migration also uses).
- **Running join again updates it.** In a folder that already has a board, join reads the default branch again and, when it changed, records it and says so ("Its branch is now trunk (it was master).") before offering the restart. A renamed default branch is picked up by rerunning join.
- **Builds, land and Main use it.** A local board's builders branch from its folder's local copy of `branch`, else `main` (`board/worktree.mjs` `builderRepo`). `land` rebases onto and fast-forwards that branch, the one `builderRepo` names for the board, and the Main card builds its tip (`hub/try.mjs`). A board on a shared clone already used `branch` for builds and Main, and now lands on it too.
- **Land refuses the wrong checkout, naming the branch.** When the folder has another branch checked out, land refuses: "<folder> is on feature, not trunk; switch it to trunk (git -C <folder> switch trunk) and land again". It never switches the owner's checkout.
- **Land stays local.** It still never pushes; pushing is separate.

Considered: asking `gh repo view` for the default branch. `refs/remotes/origin/HEAD` answers offline and for any host, and the checked-out branch covers a repo with no origin. Also considered: having land switch the folder to the branch itself, which could carry the owner's uncommitted work across.
