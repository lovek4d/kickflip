# The implementer limit counts cards In Progress

Card #643. With Maximum parallel implementers at 1 during the 0.14.0 lands, the pull kept starting builds while about ten handed-back builds sat In Progress waiting to land. The owner's note: "not sure why so many tasks kept being pulled in on this round, despite some in progress tasks still pending a land phase. maybe need to tweak what is considered a running ticket". The audit log showed all four extra builds came from the pull, one at a time, each as the build before it handed back. The limit behaved as written: it counted live implementer agents only, and a hand-back waiting in Orchestrator review had none (gh354-review-slot).

The grill on #643 settled it (t276-count, t276-taps, t276-show). The owner: "Simplify to this option for now, then we can consider where to relax later. Need to start from simplicity, number in lane", and on taps and bumps, "Same thing, simplify and then we can look for pain after".

## Decision

- **The limit is the number of cards In Progress.** `domain.mjs pullOf` counts open cards in the In Progress lane, one slot each, whatever runs on them: building, in Orchestrator review, landing, waiting on the owner, paused or stalled. A card counts from its build starting until it lands or closes. Cards in Todo and In Review take none. A card pulled but not yet started still holds its slot, as before.
- **Nothing else counts.** Agents are no longer counted. A card's helpers, writing or read-only, launch at once on their card's slot. Landers, rebase runs and resumed builds act on cards already holding a slot, so they take no extra one. The paused and stalled exceptions are gone.
- **Taps and bumps wait too.** A bump only puts the card at the front of the pull's queue. Nothing starts past the cap, and nothing is bumped out (`bumpOutsOf` and `stop.mjs bumpOut` are gone). The owner's Implement tap (`card-build`) with every slot taken bumps the card instead of starting it, as it does for a blocked card: it stays in Todo with the line "Can’t start yet: waits on a free implementer slot. Bumped to the top of Todo.", and the pull takes it first once a slot frees, if it is ready. A bump-out pause left on a record from before this change drops or resumes on the next pass.
- **Idle is unchanged.** The board is idle when no implementer agent runs and no card waits in Orchestrator review, so triage and the PR review wait as before.
- **No display change.** A ready card waiting for a slot reads plain green "ready" in Todo (t276-show). The settings line under Maximum parallel implementers now says it counts cards In Progress.

## Consequences

- With a low cap, a card waiting on the orchestrator's review or the owner's Merge holds up the pull. That is the point: the cap now limits work in flight, not just live processes.
- This supersedes [the implementer limit counts agents, and any agent on a card can ask the board for helpers](2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md) on what the limit counts and when a helper launches, and the "Past the cap" and "A bump-out" parts of [a bump marks the priority through every lane](2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md).
