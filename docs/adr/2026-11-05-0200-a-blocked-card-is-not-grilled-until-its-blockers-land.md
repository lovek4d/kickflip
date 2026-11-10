# A blocked card is not grilled or prototyped until its blockers land

Blocked by stopped a build but not a plan. The board's grill on arrival ([every card arriving in Todo is grilled by the board](2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md)) would start on a card whose blocker is unplanned, and the orchestrator held such cards by hand (#187, #193, #237, #247), a hold that does not lift when the blocker lands. The owner (#247, #249): a design built on an unlanded blocker goes stale.

- **Arrival waits on blockedBy.** `arrivalsOf` skips a card with an unfinished dep. When the last dep reaches Done the card arrives on the next Auto pass, with the grill or prototype it would have had. Grills and prototypes wait the same way (gh249-kinds).
- **The owner's taps run now.** A Grill or Prototype tap on a blocked card is an item event that never passes through `arrivalsOf`, so it runs at once (gh249-owner-tap).
- **Holds are not needed for this.** The holds on #187, #193, #237 and #247 stood in for the rule; the orchestrator lifts them once this lands. #220 stays held because the owner asked.

Considered:
- waiting only until the blocker's own plan is settled: the survey found no stale design, but the owner chose to wait until every blocker is done (gh249-wait-until).

Superseded by [a block only keeps a card from In Progress](2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md): a blocked card is grilled and prototyped as any other, after the unblocked arrivals.
