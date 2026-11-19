# A blocked In Progress card takes no slot

Card #805. With the cap at 3, T-462 sat In Progress blocked by T-469, which sat ready in Todo and could not be pulled because the three slots were full: a deadlock. The owner: "the blocked in progress task never takes up a slot, it's blockers are prioritized if ready, and it is first in line to take a slot once unblocked", and "only if the blockers are ready, else allow other items to flow through."

## Decision

- **A card In Progress blocked by any task takes no slot**, whatever lane the blocker is in. `domain.mjs pullOf` counts only the open In Progress cards with an empty `blockedBy`. It supersedes the count in [the implementer limit counts cards In Progress](2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md) for these cards. The owner's block and a blocked-until date are not a task, so a card held by them keeps its slot.
- **Ready blockers pull first.** The blockers of every blocked In Progress card go ahead of the rest of the pull, bumped first within each group. A blocker that isn't ready (`pullable`) is skipped, and the other ready cards flow as usual.
- **First in line once unblocked.** A build a block paused resumes only while the cards holding a slot, the ones waiting to resume apart, are fewer than the cap (`pauseWork`, given the cap), oldest pause first. Until then it counts as holding a slot in `pullOf`, so nothing new is pulled past it.

## Consequences

- The cap can briefly be exceeded by a card whose blocker lands while every slot is taken; it resumes when the next slot frees.
- A lost launch is a separate card (T-473).

Superseded in part by [a bump goes first in every queue](2026-11-19-0242-a-bump-goes-first-in-every-queue.md): bumped cards pull ahead of the blockers, which go ahead of the rest.
