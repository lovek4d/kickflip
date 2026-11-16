# A card in New takes no writes until it is triaged

On a coworker's board (11/14) a New card looked idle for 9 minutes while the session answered the ask with thread lines and never sorted it; each delete and resend then lost T-12 and T-13. That board ran code from before [the triage step](2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md). Today the intake wait tells the orchestrator to triage first, but nothing enforced it.

- **Writes refuse while a card is in intake.** `reply <key>`, `thread <key>` (the orchestrator's lines), `item brief`, `item set` (but not the Quick pair's `--phase ready --from-ask`) and `question add` with an `item:<key>` topic fail with "<key> is still in New: sort it first with item triage …" (`bin/board.mjs` `WRITES`, `store.mjs` `refuseInIntake`, the same `inIntake` that `item triage` checks). `item triage` is the one command that takes a card out of intake.
- **The owner's own thread line is not refused** (`thread --who love`): a New card is made of the owner's message.
- **Delete stays as it is** (owner, t345-delete).

Considered: leaving the New strip as soon as the session posts on a card (the card would read stuck-free but stay unsorted, with lines under it); refusing is mechanical and makes a New card with lines under it impossible.

A Quick build ask keeps its path: `item notes <key>`, then `item set <key> --phase ready --size small --from-ask <id>` sort a New card as `item triage` does, so neither is refused (orchestrator, on review). The refusal names both ways out. `item notes` alone writes only notes, so it is not guarded.
