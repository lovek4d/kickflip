# A closed task's worktree goes, and the hub sweeps what is left

Until now a card's worktree went only after a local land (worktree.mjs landPrepared). A task closed any other way (won't do, split, a closed ask, a PR merged on GitHub) left its worktree and branch for good, agent and failed-land logs were never deleted, and a test file killed outright left its temp dirs in the system temp folder.

## Decision

- **Every close removes the task's worktrees.** changeItem's close (cards.mjs, which every kind of close goes through) calls runs.mjs removeCardWorktrees: each worktree the card's records keep (its builds', its helpers') and the card's own goes with its branch, through worktree.mjs removeClosedWorktree, when it holds no commits that its base lacks, here or on origin, and no uncommitted changes. A card whose PR merged counts its commits as landed, as GitHub's squash leaves them off the base's history.
- **Unlanded work stays 14 days.** A worktree holding work stays, and the card's thread gets a `worktree-kept` line saying why: "Kept its worktree, removed in 14 days: 1 commit never landed". All of a card's worktrees also stay while a run the board launched for it still lives (its launch claim). Owner, 11/22: keep it with a line, and remove it after 14 days.
- **The hub sweeps once a day, and as it starts** (hub/leftovers.mjs, poll `leftovers-sweep`). A folder under ~/.claude/kickflip/worktrees goes when every builder record naming it is a closed card's (in its item file or the Done archive) with no launched run alive: at once when clean, else 14 days after the close. A folder git no longer lists goes once it is a day old, since a younger one may be a worktree being added. A folder no record names, such as a board's prototype base, stays. `git worktree prune` runs in each repo it removed from. The start-up run is the one cleanup of what is already on disk; it is also what makes the sweep happen at all on a hub that restarts more than once a day.
- **Logs keep 14 days.** The same sweep deletes agent logs (headless.mjs AGENT_LOG) and failed-land logs (worktree.mjs LAND_LOG) last written more than KEEP_DAYS ago, as host-load-log.mjs does for its days. Owner, 11/22: 14 days, like the host-load logs. Script run logs and the hub's own logs are not agent logs and stay.
- **A test run has its own temp folder.** nodeTests sets the run's TMPDIR to a folder of its own, `kr-` and six characters in the system temp folder, and removes it as the run ends, so what a test file killed by SIGKILL made goes too. The name is short because a unix socket path under it (Chrome's singleton socket, a test's) must stay under about 104 characters. shared/temp-dir.mjs also removes its dirs on SIGTERM and SIGINT and raises the signal again.

## Consequences

- The sweep runs in the hub's process, so it is async end to end: git through execFile (worktree.mjs gitAsync), and every read, stat and removal through fs/promises, after the hub page's sync reads stalled the hub for minutes under load (T-839). hub/leftovers-hub.test.mjs checks the hub answers while a sweep waits on a slow git. It reads each board's manifest entry rather than listBoards, and takes a card's base as its own PR base, else the board's branch, else main, as builderRepo does.
- The close path in the board (removeCardWorktrees) uses the same async removal.
- A builder session the board didn't launch (no launch claim) still working in a worktree when its card closes isn't seen as running; its worktree goes if clean.
- Worktrees moving to a folder per board is a separate task (T-841).
