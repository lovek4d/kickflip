# A grill with nothing left to ask ends ready

A grill that finds no decision to put to the owner ends its card ready, with a size and notes, so auto-pull builds it. Where the owner asked for prototypes, or a board rule wants a UI prototype first, it ends prototyping, never ready ("why is this marked ready? i asked for prototypes"). It never leaves a Next that asks the owner to mark the card ready; there is no such control.

The status "planned" is gone. An unstarted card has no status (a card with deps reads waiting), and `item set --status planned` is refused. The board server drops the status from every existing card as it starts (store.mjs dropPlannedStatus).

From answers gh284-end and gh284-word.
