# Worktrees live in one folder per board

A card's worktree is made at `~/.claude/kickflip/worktrees/<route>/<id>` (board/worktree.mjs `worktreePath`), the route being the board's. Before, every board shared `worktrees/<id>`, so two boards' tasks with the same id (T-4) shared a path, and the second build refused or took the first's.

- **One function names the path.** Making a worktree (a builder's, a helper's `<id>-<name>`, a PR's) and every fallback that reads one when a record keeps none (`finish.mjs`, `land`) go through `worktreePath(site, id)`. With no board at `site` the folder is `worktrees/<id>`, as before.
- **Branches don't move.** Only the folder does ([builder branches are named by user, board and ticket](2026-11-18-1220-builder-branches-are-named-by-user-board-and-ticket.md)).
- **Existing worktrees stay where they are** until their tasks close: every reader takes the path from the builder record, so an old record's `worktrees/<id>` keeps working.
- **The leftovers sweep looks one level deeper** under a folder named for a board's route that holds no `.git`; every other folder, the prototype bases included, is looked at as before. The builder guard and the try path check match by the `worktrees/` prefix, so they need no change.
