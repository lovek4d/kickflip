# A wait a block held is owed from the block's end

Card #1002, the owner's codebase-design follow-up to [a staging wait that returns at unblock wakes the orchestrator](2026-11-17-1930-a-staging-wait-that-returns-at-unblock-wakes-the-orchestrator.md).
Each wait kind worked out for itself what a block meant: staging and limbo checked `!it.blocked`, the past-Todo
unblocked wait read `unblocked_at`, a ready card's block's end had its own `recheck_at` and `recheck` wait, and only
staging voided a pickup from before the block. Owner's answers: all through one rule (t651-held); move `since` to the
block's end (t651-since); and, asked what `recheck_at` meant, "Can't that just auto kick back to staging?".

## Decision

- **One rule at the waits seam.** `orchestratorWaitsOf` holds `HELD_BY_BLOCK`: staging, limbo and unblocked. A wait
  of those kinds drops while its card is blocked. Once the block ends, its `since` is the later of its own and
  `unblocked_at`, and a pickup (a write or the watcher's working mark) from before that `since` doesn't count, so the
  returning wait opens unpicked and `waitsStep` wakes the orchestrator. Only the latest unblock counts: `markUnblocked`
  overwrites the field, and an `unblocked_at` from before the wait began changes nothing.
- **Every unblock records `unblocked_at`**, in every phase.
- **A ready Todo card whose block ends goes back to staging**, `staged_at` its Unblocked line's time, `ready_at` and
  `ready_main` dropped, the owner's Implement tap (its bump) kept. The staging wait is the re-judge against what landed.
  Its next text asks for the answered questions to be read against what landed, and `question settle <id> --note`
  answers a stale one again on any staged card. `recheck_at`, the `recheck` wait and the pull's recheck gate are gone.
- **A blocker that touched none of the task's noted files leaves the card ready**, with the line "Stays ready: <blocker>
  touched none of this task's files" and no `card-unblocked` event, as
  [a recheck whose blocker touched none of the task's files releases itself](2026-11-17-0700-a-recheck-whose-blocker-touched-none-of-the-tasks-files-releases-itself.md)
  had it release the recheck. The line keeps its stored kind, `recheck-released`, so old threads still render.
- **Migration** `recheck-staging`: a ready card holding `recheck_at` moves to staging from that time, which is also
  recorded as its `unblocked_at`; the field is dropped from any other card.

It amends [a block only keeps a card from In Progress](2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md)
and supersedes the staging-only void of the 1930 decision.
