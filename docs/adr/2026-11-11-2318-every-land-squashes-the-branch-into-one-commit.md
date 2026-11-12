# Every land squashes the branch into one commit

Status: accepted (#576, 11/11). Supersedes the per-commit checks in [commits are Conventional and name their card in a Refs trailer](2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md).

## Context

The owner, in T-152's thread (11/11): "we should be squashing commits to main. For now always, we can add a setting way down the line, don't even worry about it. Every merge to main should be a squashed PR. Also should be enforced mechanically".

A board with PRs already squashes: `board.mjs merge` runs `gh pr merge --squash`. A local land didn't. `prepareLand` rebased every commit on the builder's branch onto main and fast-forwarded main to it, so a builder's fix-ups, a "review fixes" commit and a helper's merge commit all reached main. Land checked each of those commits against the commit standard and required a `Refs: <ref>` trailer on each one. Builders kept tripping on the trailer, for example with a blank line between `Refs:` and Co-Authored-By.

The owner tapped Implement on the grill's recommendations.

## Decision

**Every land squashes, with no setting.** `squash` in `board/worktree.mjs` runs in `prepareLand`, in the worktree, before the rebase. It runs `reset --soft` to the branch's merge-base with base and commits once. The rebase then moves that one commit, so a conflict is resolved once rather than per commit. The squash commit's tree is the branch's tree, so `refs/kickflip/tested/<branch>` and `landPrepared`'s `--ff-only` stay as they were. A branch that is already one commit with the squash message is left alone, so a second prepare (main moved, or a held build's Merge tap) doesn't rewrite it again and the tested-ref shortcut still holds. A branch whose commits change nothing is refused as nothing to land. This covers `land` without `--site` too. Enforcement is land only: no GitHub repo setting changes.

**The squash message comes from `squashMessage`** in `board/commit-message.mjs`:
- The subject is the builder's `--title` (`builder done` and `builder verified` already take it), else the branch's first commit's subject. "First" means first along the first-parent line, so a helper's commits never stand for the branch.
- The detail is the first commit's body, without its Refs and Co-Authored-By lines.
- Then comes one trailer block with no blank line in it: `Refs: <card ref>`, then each Co-Authored-By line any of the branch's commits carries, once each, matched without regard to case. A land with no card keeps each Refs the commits carry, once.
- Later commits' subjects and details are dropped.
- The author and date are the first commit's.

**Checks run on the squash message only, before anything is rewritten.** A bad `--title` is refused as finish refuses it for a PR. A squash subject that is empty, or on a card off the commit standard, is refused. So is a message still holding a "# Conflicts:" note. Each refusal names the first commit, where the subject and detail come from. A fix-up commit's subject no longer has to be Conventional. Land no longer checks for a `Refs:` trailer, since it writes one itself.

## Consequences

- Main gets one commit per land, so `git log` on main reads as one line per card.
- A refusal from the rebase that follows the squash undoes the rebase but keeps the squash. The builder or lander then resolves one commit.
- A builder's or lander's hand rebase no longer has to keep each commit's message intact. Land rebuilds the trailers from the first commit and the card, and only the first commit's subject and detail survive.
- The briefs still ask for the commit standard and a Refs trailer on each commit. Land doesn't need the trailer anymore, but a commit read in the branch still names its card.
