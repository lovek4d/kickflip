# A read-only helper never moves a card

A read-only helper launched on a Todo card (a discussing ask measuring something) counted as a started build, so the card moved to In Progress, waited as unowned for a builder it never had, and `item set --phase` refused it from there.

`movesCard` (domain.mjs) is the one rule: a build agent's record places its card unless it is a read-only helper, the rule `pullOf` already used for slots. It decides which runs place a card in laneOf, whether a card has started, and which running builds take an implementer slot. A read-only helper so never moves a Todo card, never takes a slot, and never moves an In Review card back (ADR 2026-11-06-1546). A writing helper still moves the card, as a run that can change code does (ADR 2026-11-10-2030).

The `return-helper-cards` migration sends a card already In Progress with no PR, pushed branch or hold, whose only started runs are read-only helpers, back to Todo in discussing; its earlier phase is not stored.
