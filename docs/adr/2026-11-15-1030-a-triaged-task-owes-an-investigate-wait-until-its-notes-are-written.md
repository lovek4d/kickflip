# A triaged task owes an investigate wait until its notes are written

After `item triage` the intake wait ended and nothing else waited on the orchestrator to investigate, so a busy orchestrator could skip it (T-401's builder, call 7). This extends [a new task is triaged in one command before it is investigated](2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md).

- **The wait.** A card item triage sorted owes the orchestrator an `investigate` wait (`domain.mjs` `orchestratorWaitsOf`), "Investigate <key>: write its notes (item notes), then reply", counted from the triage's `triaged.at`.
- **It ends** when `item notes` writes the card's notes (`store.mjs` `appendNotes` stamps `triaged.investigated_at`), when the orchestrator posts a reply in the card's thread (any Claude message after the triage that is not the "Triaged:" line), or when the card's phase moves off the one triage gave it.
- **A fold owes none**: the card is gone. A Quick build ask sorted ready with `item set` never went through triage, so it owes none.
