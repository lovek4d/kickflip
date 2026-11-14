---
status: superseded by 2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping
---

# A card leaves a wave only once no open card waits on it

This amends "Removing a card drops its links both ways" in [a wave's cards wait only on the earlier cards they'd conflict with](2026-11-09-1321-a-waves-cards-wait-only-on-the-earlier-cards-they-conflict-with.md). The owner, on #451's gh451-remove: "dropping a wave should maybe not be a purely programmatic thing." Dropping the links by itself could free a card that still conflicts with something.

- **`wave remove` refuses while an open wave card waits on the card** (owner, gh472-remove-waiters): the refusal names each waiting card and the `wave set <slug> <card> --after …` to run. The orchestrator relinks each to its real conflicts (`""` for none), then removes. A removed card that is already Done blocks nobody, so the wave's cards drop their links to it as before.
- **The leaving card keeps its own links** (owner, gh472-remove-own): to the wave's earlier cards they stay as ordinary blocked-by; `item set --deps` clears one that no longer applies.
- **`wave finish` keeps the links** (owner, gh472-finish), as before: it only takes the band out of Todo.
- **A removal that lifts a `wave:<slug>` block sends the Unblocked notice** (found by #470): an Unblocked line in the waiting card's thread, "<card> left the wave", and a `card-unblocked` event.

There is no command that drops a wave, so `wave remove` was the only programmatic drop.
