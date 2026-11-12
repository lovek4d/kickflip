# Sorting a card answers its own ask

A New card's ask is marked working when the watcher hands it over. `item set --phase ready|grilling|prototyping` writes a command line that claudeAtOf skips, so the ask kept reading "Working on it" after the sort, and `pullOf` and `arrivalsOf` skip a working card: a readied Quick build sat in Todo and a sorted card's planner never launched.

`threadOf` now reads a card's own ask (`from_ask`) as answered once the card has a phase. It is derived in domain.mjs, not cleared in working.json, so nothing is written and it holds for every route that sets a phase.

Only that ask ends. The owner's other messages from before the sort keep working until a reply or a later Claude line (owner's answer, 11/11).
