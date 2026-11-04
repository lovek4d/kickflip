# Land refuses a commit message that breaks its form

Commit subjects start with the card's ref and a colon (`#114: ...`), and #74 landed on 11/03 with a leftover `# Conflicts:` block after its trailers: a `rebase --continue` under `core.commentChar=';'` (#113) keeps git's `#`-prefixed conflict note as message text. The orchestrator fixed it by hand before pushing.

- **Land refuses, it doesn't strip.** `board.mjs land` (`board/worktree.mjs` `refuseBadMessages`) refuses a branch with a commit whose message holds a `# Conflicts:` line, naming the commit and saying to amend it out. Rewriting history inside land would change commits the builder didn't write.
- **The subject check follows the card's ref.** With `--site`, every commit the branch adds must start `<ref>: `, the ref `builder start` prints (`board/bin/board.mjs` passes `cardName`). Without `--site` there is no card, so only the conflict check runs.
