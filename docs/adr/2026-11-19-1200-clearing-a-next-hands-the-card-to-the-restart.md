# Clearing a Next hands the card to the restart

[An In Progress card always has a builder line or a Next](2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md) made `item set` refuse any write that left a started card with nothing building and no Next, `--clear-next` included. Since the board restarts such a card itself (`runs.mjs` `stuckBuilds`, through `owesNext`), the refusal cut off the one card that needs it: one the orchestrator had once given a Next could never have it cleared to reach the restart.

`--clear-next` and `--next ""` now go through. The refusal stays for the other writes that turn a card into one owing a Next (`--clear-status` off checking, `--unheld`), and `builder done` still asks for `--next`.
