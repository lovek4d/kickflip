# A task can keep its own PR base

A board's builders branched from, and its finish opened PRs against, one branch: the board's (`boardRepo` branch,
else main). A repo that routes some changes to another branch (agent code to `agent-main` instead of `main`) had no
way to give one task's PR a different base. GitHub issue #1116 reported what followed: `builder verified` opened draft
PR #A against `main`, the orchestrator retargeted it to `agent-main` with `gh pr edit --base`, and seconds later a
finish opened a second draft #B on the same head branch against `main`, linking both to the task.

## Decision

- `item set <key> --base <branch>` stores the task's own base on its item (`base`); `--base ""` clears it. It is
  refused on a board that lands in its own folder (a local board, or the hub board on Merge), where no PR opens and a
  land onto another branch would need its own design.
- `builderRepo(site, { id })` (board/worktree.mjs) reads it: on a board whose finish pushes (`remote`), the card's base
  stands over the board's branch. Every card-specific caller passes the id: the builder's worktree (`boardWorktree`,
  made from origin's copy of the base), the builder's and lander's briefs (`launchBuilder`, `landByBuilder`), the
  finish (`finishCard`, `landHeld`), and rebase runs (`rebasesDue` takes `baseOf(key)` and keys a conflict on the
  card's base, so a conflicting `agent-main` PR is never rebased onto `main`). Board-wide callers (the ready expiry,
  `prWorktree`) keep the board's branch.
- A build already started keeps the branch it made; setting `--base` later changes what its finish counts commits
  against and opens its PR on.
- With no PR recorded on the card, the finish asks GitHub for an open PR from the card's branch, whatever its base
  (`gh pr list --head <branch> --state open`), and moves the card to it, pushing with a lease after fetching the
  branch, instead of opening one. `gh pr create`'s own "already exists" only covers the same head and base, which a
  retargeted PR no longer shares. A lookup gh can't answer (its limit, an outage) counts as none, and the create that
  follows reports the reason as before.

## Left out

- Dropping a closed PR from a task's PR list: the issue names it as a symptom, not as an ask.
