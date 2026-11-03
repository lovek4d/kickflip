# A held Todo card shows Build in place of Unhold

This supersedes in part [0139](0139-a-build-tap-starts-the-build-in-the-board-server.md), which refused a Build tap on a held card, and [0023](0023-a-card-can-be-held-and-every-card-button-confirms.md), on Unhold being a held card's only way back.

The owner on #78: "Held to do items should still have a build button and the build button will take it out of held and just build it. In fact, if it's already held, we can only have the build button instead of a resume or unhold."

- A held card in Todo is `buildable` (`board/domain.mjs` `buildableOf`) when nothing else stops it, and shows Build with no Unhold. Its confirm reads "Unhold and build <ref>?".
- The tap clears the hold as the `card-hold` resume does (`store.mjs` `recordOwnerTap`, with the owner's "Resumed." line), then starts the build as [0139](0139-a-build-tap-starts-the-build-in-the-board-server.md) describes. Blocked cards and unconfirmed prototype picks are still refused first, so a refused tap leaves the hold alone; a start that fails after the hold is cleared puts the hold back, pick-up time included.
- A held card outside Todo keeps Unhold and is still refused a Build tap.
