# An ask only a planner ran on is refused Done like one nothing ran on

Amends [a finished ask waits in Todo with an orange Close](2026-11-12-2300-a-finished-ask-waits-in-todo-with-an-orange-close.md).

The refusal of `item set --done` on an ask counted every agent record on the card, so an ask that was only grilled, prototyped or drawn (a planner record) slipped past it and went straight to Done. It now counts build records only (`builds` in `domain.mjs`): an ask with only planner records is refused and waits in Todo for the owner's Close; one with a build record is not.
