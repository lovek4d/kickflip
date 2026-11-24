# A block holds every transition, and its end moves the card or opens a wait

Card #1184 (T-833). T-810's headless builder exited while T-830 blocked it; its stall cleared, yet the orchestrator's
waits kept "stale #1145 … restart it once", which nothing could do until T-830 landed. The owner (11/22): "stale should
be an alert that something is not being addressed due to a fault", and "pretty much every transitionary building phase
should be blocked by the block. And then unblocking should start a wait for the orchestrator to deal with whatever is
the next step, if applicable, or if it can move mechanically, it should move mechanically."

A review (visuals/T-833/review.html) found a block held only the pull: a restart or resume of a blocked In Progress
build, the PR opening and leaving draft, review links and the owner's own block all slipped through, and two ways a
block ends (blockers edited away, the owner's Unblock) recorded nothing. The owner's answers on the card: blocking a
ready card drops it back to staged, and the cards ready and blocked move to staged; the owner's block holds what any
block holds past Todo (builder, PR, land); a blocker that closes without landing unblocks its waiters and opens a wait to
check each still applies.

## Decision

- **One block check.** `blockWordsOf` (board/domain.mjs) reads all three blocks, "by the owner", "by #53" and "until
  <condition>", and `it.blocked` is its yes or no. Every hold reads it:
  - staged to ready: `item set --phase ready` refuses a blocked card, and a block added to a ready Todo card (by
    `--blocked-by`, `--blocked-until`, `--blocked`, `item add --blocks`, or the owner's Block tap) sends it back to
    staging with a "Marked as staged" line;
  - the pull, as before;
  - a build's start (setItem `--start`, as before), its restart on a card already In Progress (`startBuilder`), the
    board's restart in place (`restartStuckBuilds`) and relaunch of an exited builder (`reviveHeadless`), and the
    resume of a handed-back or gone build (`builder resume`, and the server's reruns); a running build still takes news;
  - the PR's opening, or a plain remote's push for its merge (`sendForReview`); a push to an already open PR (a rebase
    or fix run) goes on;
  - a draft leaving draft on a board that skips the draft (hub/github.mjs `readyGreenDraft`) and review links going
    out (slack-store.mjs `reviewDue`);
  - the Merge and the land (`mergeCard`, `tapMerge`, `landCard`, `landSkipOf`), now the owner's block too.
  Lane moves need no hold of their own: a lane follows the facts these hold.
- **The owner's block past Todo.** Only a close clears it; a build's start is refused while it stands, and a
  hand-back, `--pr`, `--pushed` and `--merge-ready` keep it. The owner's Implement still lifts their own block to start
  the build at once.
- **One block-ended step.** `blockEnded` (board/cards.mjs) runs whenever nothing blocks the card any more: a blocker
  landing or closing (`unblockedBy`), `--blocked-until ""`, `--blocked-by` edited so none is open, `--unblocked` or
  `--pick-up-at ""`, the owner's Unblock tap and a timed block running out (`pickUp`). It records `unblocked_at` from
  its thread line and raises `card-unblocked`. Then:
  - **moved mechanically** where something already picks the card up: a staged card's staging wait reopens, owed from
    the unblock; a paused build resumes (`pauseWork`); a verified build's land step launches its lander; an exited
    builder's tracked launch relaunches;
  - **one `unblocked` wait** otherwise, past Todo: a build whose builder is stopped or silent ("restart the build with
    builder resume"), or a handed-back card with no builder ("act on what it waited for").
  - **A blocker closed without landing** (no landed commit and no merged PR) writes "Unblocked: X closed without
    landing." and keeps `unblock_check`, so the `unblocked` wait, in any lane, asks whether the task still applies. A
    thread line ends it.
- **Stale is a fault only.** A blocked card never reads stale: no stale wait, no stale footer word, for a stopped or
  silent build or a quiet review. Once its block ends, a builder that isn't running is the `unblocked` wait's, and only
  after a thread line picks that up does a still-stopped builder read stale again.
- **Removed.** The staging wait on a blocked card, which asked for a ready the CLI now refuses; the "stays ready if the
  blocker changed none of its files" check (`namedPaths`, `landedFiles`, the `recheck-released` line, which still
  renders in old threads), since a blocked card is never ready; and with it a ready card's demotion at its block's end.
  The ready expiry needs no blocked case.
- **Migration** `blocked-ready-staging`: each ready Todo card a block holds when the board starts moves to staging.

It supersedes [a recheck whose blocker touched none of the task's files releases itself](2026-11-17-0700-a-recheck-whose-blocker-touched-none-of-the-tasks-files-releases-itself.md)
and the amendment of [a blocked card owes the owner nothing](2026-11-16-1000-a-blocked-card-owes-the-owner-nothing.md)
that readied a blocked card and kept its staging wait. It amends [a block only keeps a card from In Progress](2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md),
[an unblock past Todo waits on the orchestrator](2026-11-07-1500-an-unblock-past-todo-waits-on-the-orchestrator.md),
[a wait a block held is owed from the block's end](2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md)
and [the owner's hold is a block](2026-11-15-2230-the-owners-hold-is-a-block.md).

## Not done

- A blocked card still grills, prototypes and stages: a block holds building transitions, not planning.
- An orchestrator's plain `item set --done` counts as closing without landing, so its waiters get the check wait.
