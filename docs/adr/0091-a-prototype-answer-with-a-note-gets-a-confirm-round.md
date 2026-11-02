---
status: superseded in part by ADR-0111
---

# A prototype answer with a note gets a confirm round

Superseded in part by [0111](0111-a-prototype-round-ends-with-a-one-take-confirm.md): the board opens a one-take confirm after every take the owner picks, and a note that changes the take gets a new prototype round (`round_of`) rather than a hand-written confirm. The building gate still holds.

The owner asked on hub/INT-208 that a card never build on a take the owner changed in a note without one more look at the final version, unless the note says go. That rested on the owning session remembering, so the board enforces it where a card starts.

- `board.mjs item set <key> --status building` refuses while the newest owner answer to the card's questions (topic `item:<key>`) whose url names a `prototype-*.html` page has a note. A recorded prototype ([0089](0089-the-board-serves-every-prototype-from-one-template.md)) and an older hand-written page count alike; questions with no prototype url don't count. The refusal is one line naming the fix: record the final version with `prototype add` and ask it with `question add`.
- An answer with no note to a later prototype question on the card lifts the gate. The newest answer decides, so a later noted answer brings it back.
- `--confirmed "<owner's words>"` on the same `item set` lets the card start when the note itself says go, such as "send it". The words must appear in that note, so the session quotes the owner rather than its own reading, and they go in a thread line on the card.
- The gate reads answers as they are sent. It doesn't judge whether a note changes the take; a note that only says go needs `--confirmed`.
