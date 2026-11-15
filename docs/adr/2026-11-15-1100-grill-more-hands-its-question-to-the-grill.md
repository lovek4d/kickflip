# Grill more hands its question to the grill

The owner, on T-190: one Grill deeper tap and a Send on the same question 3s later. The Send closed a question the grill still owed a round on, and `moveOnAnswered` staged the grilling card. "But grill should block the question (or resolve it) like prototype does."

- **Grill more reads like a prototype request.** `ownerQuestion` reads `grill-more` events beside `prototype-request` ones: the question reads `requested`, with `request.kind` saying which. The page shows "Grilling deeper" with the spinner, locked at the pick and note the tap sent.
- **A Send on a requested question is refused.** `owner-answer` and `owner-answers` answer 400 naming the grill or the prototype (`store.mjs handedOver`); `unrecorded` keeps only open questions. This was page-only for prototype requests before: the server recorded the Send, and the ADR's "an answer after the request reopens it" came of a reopen, which `question-reopen` still does.
- **The grill's next questions resolve it.** `question add` on the card's topic resolves each question its grill-more handed over, "Followed by <id>", as an answered one is. `question resolve` refuses it.
- **No card moves on while a question is requested.** `moveOnAnswered` treats requested like open: the round decides the next phase. This is not a backstop for an impossible state; a Send on another question of the card can still arrive while one is handed over.
- **Prototype rounds and waits stay prototype-only.** `roundState` and `prototypeWaits` read only `prototype-request` requests.

Extends [a prototype request waits for its prototype](2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md).
