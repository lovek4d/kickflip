# Tickets are made at ready

The grill asked every task "Create a ticket for this task?", recommending yes when it lands code. Every build lands commits, so the question had one right answer for anything that reaches a builder, and each ask was an owner round trip.

- **Ready is the point.** `changeItem` (`item set --phase ready`) and `createItem` (`item add --phase ready`, a Quick build) make the ticket through `assignTicket`, as `--new-ticket` does, when the card has none, no `--ticket` was passed and the board has a source. A `ticket-made` line says "The board made <id>." A failure refuses the write like `--new-ticket` does. `setItem` takes the tickets lock for every ready.
- **Cards that never build get none.** A card answered by a reply, closed or split never goes ready. A split parent's children get their own when they go ready.
- **The grill is silent.** `plannerBrief` has no ticket instruction and `briefFacts` no `ticketQuestion`.
- **Going forward only.** Ticket questions already open or staged when this landed stay as they are: the owner asked for the change "going forward". A yes still makes the ticket; a card that reaches ready without one gets one then.
- **Kept.** `checkTicketGate` still refuses an orchestrator-added ticket question on a card that has a ticket, and `settleAnswers` still acts on a yes.
