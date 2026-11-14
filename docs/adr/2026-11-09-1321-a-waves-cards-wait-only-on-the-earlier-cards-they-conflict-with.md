---
status: superseded by 2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping (a task still waits only on the earlier tasks it conflicts with, through its deps)
---

# A wave's cards wait only on the earlier cards they'd conflict with

This supersedes [a wave builds in phases, and cards in one phase build side by side](2026-11-04-0238-a-wave-builds-in-phases.md). There, a wave kept its cards in steps and each card was blocked by every card of the step before, so a card waited on cards it had nothing to do with. The owner, on #436: "they don't necessarily have to block in order, just when they would conflict with earlier implementation."

- **Per card, not per step** (owner, #436 gh436-edges): "each card names the earlier cards it conflicts with (`--after`), stored as its blocked-by; steps go, and existing waves keep their links." A wave keeps its cards in build order as `items: [id, …]`; order only says which cards are earlier. Each card's links to the wave's cards are its `deps`, the board's own blocked-by, and its links to cards outside the wave stay as they are. A conflict must be an earlier card of the same wave, so no cycle can form.
- **Commands.** `wave create <slug> --card <file>/<id>[:<file>/<id>,…] …` takes one `--card` per card in build order, its conflicts after the colon (owner, #451 gh451-create), in the forms `item set --deps` takes. `wave add <slug> <card> [--after …]` puts a card last with those links. `wave set <slug> <card> --after …` rewrites only that card's links to the wave's cards, and `--after ""` clears them (owner, #436 gh436-after-edit). `--step` and re-stepping go.
- **Removing a card drops its links both ways** (owner, #451 gh451-remove): the removed card and the wave's cards waiting on it lose their links to each other; one that still conflicts is relinked with `wave set --after`. Amended by [a card leaves a wave only once no open card waits on it](2026-11-09-2345-a-card-leaves-a-wave-only-once-no-open-card-waits-on-it.md): it now refuses while an open card waits on it.
- **Existing waves keep their links.** A wave stored as `phases` reads its steps flattened in order (`domain.mjs` `waveItems`), and its cards keep the `deps` its steps gave them; its next change writes it as `items`. Nothing is migrated.
- **The band** (owner, #436 gh436-blocked-by, take A): "Nothing: the board's blocked-by line, which drops when the blocker lands." A wave band lists its Todo cards in order with no step number, and each card shows the board's own "blocked by #N" line. Its Implement still goes to its first ready card, so free cards take it in turn.
- **No ⋯ Move up / Move down** (owner, #436 gh436-move): "Why are we moving up and down? This was not requested". It only swapped a card into another step; with steps gone it has no job, so the menu, `wave-move` and `domain.mjs` `waveMoved` go.
- **The order line** that `wave create|add|set` prints, and Notes' **Order**, lists the cards in order by commas, each with the earlier cards it waits on: "#1, #2, #3 (after #1, #2)".
- **An architecture review's findings** each go into the review's wave after its audit card alone, so they no longer wait on one another.

Considered:
- Keeping steps and adding per-card links on top: two ways to say "waits on" that could disagree.
