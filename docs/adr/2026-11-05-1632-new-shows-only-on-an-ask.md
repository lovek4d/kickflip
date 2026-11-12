---
status: superseded in part by 2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives
---

# New shows only on an ask; a filed card always shows its ticket

Superseded in part by [every ask is a task card from the moment it arrives](2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md): a work card an ask became is `isNew` until the orchestrator sorts it, but its ticket chip shows from the start ([a New card shows its ticket chip from the moment it lands](2026-11-11-2133-a-new-card-shows-its-ticket-chip-from-the-moment-it-lands.md)).

The owner (#337): "new should only last until the item is ingested into a real work item. effectively new always becomes either a ticket badge or an ask badge."

A work card never draws a New badge. Its ticket chip shows whether or not the card is `unsorted`, and the status word of an unsorted card in a lineup is its state or "not ready", not "new". New stays on an ask until it is handled (`askChip`).

`unsorted` keeps its logic role: `pullableCard` and the arrival check skip a card whose session hasn't set its state yet, so a just-added card is still not grilled or pulled first.
