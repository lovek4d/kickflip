# A refused start returns the card to ready

T-245 and T-503 were pulled and their starts refused. They came back to Todo still reading "reading", which `pullOf` doesn't pull, so they sat until the owner tapped Implement.

- **The phase comes back with the lane.** A start that refuses after marking the card (`startBuilder`'s worktree failure) restores `phase` with `lane` (`restoreLane`), so a card pulled from ready is ready again.
- **A refusal blocks the pull, not the card.** `pullOf` leaves a Todo card whose newest line is its refused start (`refusal`) until a later line clears it, so a refusal can't loop.
- **`builder pick` clears it.** On a Todo card with a refusal, `builder pick` adds a `refusal-cleared` line, and the next pull takes the card. A retitle (`item set --title`) clears one the same way, as the pull's title refusal had no other clearing line.
