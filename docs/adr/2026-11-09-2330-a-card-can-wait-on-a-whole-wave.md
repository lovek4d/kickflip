---
status: superseded by 2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping (a split still moves its waiters, onto the tasks it split into by key)
---

# A card can wait on a whole wave, and a split moves the cards waiting on it

Before this, a card blocked by a card that was later split stayed blocked by that card's key alone. The split closed the original with `item set --done --text "Split into …"`, a Done dep finishes the wait, so its blocked cards woke before any card of the split was built. Nothing marked a close as a split, and blocking on a wave meant listing each of its cards by hand (#467 listed #450, #451 and #449). The owner, in #467's thread: "if a ticket is split, we should consider blocking on the entire wave produced."

- **A dep can be a wave**, `--deps wave:<slug>` (owner, gh470-wave-dep): it waits on every card the wave holds at the time, read live, so a card added to the wave later blocks too, until each is Done. A card gone from its item file went to the archive Done, as any dep. store.mjs `depCards` and domain.mjs `buildBoard` expand the entry; `unfinishedDeps`, `unblockedBy`, `checkNextDeps`, the blocked-by line and Waits on it all read the expanded cards.
- **The blocked-by line lists the wave's open cards** (owner, gh470-blocked-line), as today's links: "blocked by #451, #449". No wave name is shown.
- **A card never waits on its own wave**: `--deps wave:<slug>` is refused for a card in it, and `wave add` for a card whose deps name it.
- **Finishing a wave doesn't lift the block, and can't happen early** (owner, gh470-wave-finish, "wave finish should block when wave items are not all done"): `wave finish` refuses while a card in the wave is open, naming them.
- **A split says so on its close** (owner, gh470-split-trigger): `item set <key> --done --split-into <wave:slug | keys>` rewrites each open card's dep on `<key>` to those entries, a card in the waiting card's own item file by bare id, writes a "Split: #a became …, so it waits on those now." line in each moved card's thread, and writes the closing line "Split into the wave <title> (#a, #b)" or "Split into #a, #b" itself, so it takes no `--text`. The moved cards wait on every card the split filed (orchestrator, gh470-split-moves).
- **Refused splits**: `--split-into` without `--done`, with `--text`, naming the card itself, on a card already Done (its waiting cards were unblocked at that close), and when a waiting card is one of the split's cards, which would wait on itself; when a waiting card is in the target wave, split into the new cards by key.

Calls made at build, left open by the grill:
- The split's thread line is a Blocked-marked status line, `split-moved`, since it changes what the card waits on.
- `--split-into` on a card already Done refuses rather than moving cards that were already unblocked; `item set --deps` moves them by hand.
- A wave entry and card keys may be mixed in one `--split-into`; the closing line lists each.

From #470; the wave rename and conflict-only links it builds on are #450 and #451.
