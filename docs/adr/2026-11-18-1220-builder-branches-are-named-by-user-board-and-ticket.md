# Builder branches are named by user, board and ticket

A build's branch is `<login>/<board name>/<ticket id>`, all lower case (owner, #1059, 11/18: "Lower case: hub_orchestrator/1037", "Actually lets also prepend gh username"). The board name is the board's title with spaces as `_`. The ticket id follows the board's ticket setting: a GitHub issue's bare number (`1037`), a Linear key lower-cased (`eng-42`), else the card id lower-cased (`t-708`, also used for a card with no ticket from the source). Example: `lovek4d/hub_orchestrator/1037`.

- **Login.** The board's `github_login` setting, else gh's signed-in user (`gh api user --jq .login`), read once per process and not kept while gh has none. With neither, the branch is `<board name>/<ticket id>`.
- **Only the branch moves.** The worktree folder stays `~/.claude/kickflip/worktrees/<card id>`. Land, resume and the finish read the branch from the builder record's `worktree.branch`, so branches made before this keep their names, and a card resumed after it keeps its old one. A ticket made after the build started doesn't rename the branch.
- **Nesting.** Git can't hold both `a/b` and `a/b/c`, so a build whose branch has an existing branch as a prefix, or as a prefix of another branch, refuses with a message naming that branch.
- **Not renamed.** A helper's branch stays `<card id>-<name>`, and a board with no board at the site (the kickflip fallback) keeps the card id.
- **Leftover worktrees.** A leftover worktree holding no work is remade whether it is on the old card-id branch or the new name.

Code: `board/worktree.mjs` `branchName`, `makeWorktree`.
