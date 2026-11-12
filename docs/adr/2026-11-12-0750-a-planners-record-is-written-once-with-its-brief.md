# A planner's record is written once, with its brief

`startPlanner` and `startVisual` used to open the agent's record with `startBuilder` and add the brief in a second write. Between the writes the record had a kind and no brief: a test reading it in that gap failed, and a crash there left a brief that was off the card and not on the record.

`startBuilder` now takes the brief and writes it into the record it opens. The card's copy is dropped only after that write, so a crash leaves the brief in both places (a resume launches from the record) and never in neither. A start refused before the record is written, such as a held usage gate, leaves the brief on the card.

This follows [every planner launches from the orchestrator's brief](2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md).
