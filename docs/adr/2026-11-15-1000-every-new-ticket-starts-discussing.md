# Every new ticket starts discussing

The board grilled every card that arrived in Todo (`arrivalsOf`, `launchArrivals`). Since asks sort to discussing and `item add` on a board needs a phase, the cards left to reach it were few: cards added with no phase, cards filed held, and cards a ticket source or another board brought in. The owner (T-213, 11/12): "Do let me know on whether arrival grill code can be thrown out."

- **A card with no phase starts discussing.** `item add` with no `--phase` (held or not, on a board) files the card discussing and writes a `discussing-start` line saying where it came from (its Parent, else that it was filed with no phase). A card filed held keeps its hold and no longer waits New for an unhold.
- **Existing New cards move once.** The board server, as it starts, moves each Todo card with no phase that no ask made to discussing, with the same line (`store.mjs discussNewCards`).
- **Asks stay New until sorted.** The card an ask became is the orchestrator's to sort; one filed held and later unheld reads New for the orchestrator to sort, as any ask does.
- **A grill or prototype brief is owed when a card enters the phase.** What an arrival owed for a card filed or sorted straight into grilling or prototyping, `item add --phase grilling` and `item triage`/`item set --phase`, the card now owes the moment it enters that phase, as one sent from discussing already did.
- **Gone.** `arrivalsOf`, `launchArrivals`, the `arrival-planner` audit call and their tests.

Supersedes [every card arriving in Todo is grilled by the board](2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md) and [a card filed held stays New until unheld](2026-11-07-1300-a-card-filed-held-stays-new-until-unheld.md).

Considered:
- keeping the planner cap on briefs owed at filing: a brief the orchestrator writes launches at once ([every planner launches from the orchestrator's brief](2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md)), so `max_planners` no longer throttles anything; whether the setting stays is a separate call.
