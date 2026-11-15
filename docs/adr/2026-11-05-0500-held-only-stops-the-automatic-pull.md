# Held only stops the automatic pull

Superseded in part by [the owner's hold is a block](2026-11-15-2230-the-owners-hold-is-a-block.md): held is the owner's block, so the card reads blocked and not ready.

Supersedes in part 2026-10-29-1639-a-card-can-be-held-and-every-card-button-confirms.md, where a held card waited on
nobody.

## Decision

Held stops the board from pulling a card into In Progress on its own: `queueable`, `pullOf`, `arrivalsOf` (so no
automatic grill) and the answered-and-ready check keep their `!held`. Nothing else changes for a held card:

- Needs you (`needsOf`) and a card's Action needed (`actionOf`) list a held card's open questions and other owner asks
  like any card's, and its questions push to the phone. The Todo card line reads "held · Action needed".
- Grill, Prototype and answering a question leave the hold as it is.
- Implement takes the hold off, as the owner's own pull, whatever unstarted status the card has (`planned`, `waiting`
  or `held`). Only a held card that has started is refused.

## Why

#35 was held and grilled: its questions showed on Open questions but not in Needs you. #255 had a `waiting` status, so
Implement refused it as held instead of unholding it.
