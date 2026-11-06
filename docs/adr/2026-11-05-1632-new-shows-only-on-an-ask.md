# New shows only on an ask; a filed card always shows its ticket

The owner (#337): "new should only last until the item is ingested into a real work item. effectively new always becomes either a ticket badge or an ask badge."

A work card never draws a New badge. Its ticket chip shows whether or not the card is `unsorted`, and the status word of an unsorted card in a lineup is its state or "not ready", not "new". New stays on an ask until it is handled (`askChip`).

`unsorted` keeps its logic role: `pullableCard` and the arrival check skip a card whose session hasn't set its state yet, so a just-added card is still not grilled or pulled first.
