# A grill ends asking to implement, prototype or discuss

Superseded by [Implement is only the card's tap](2026-11-18-0100-implement-is-only-the-cards-tap.md) (#1003): no question offers Implement; a grill ends on the card's Implement ask.

Card #590 (T-206). A grill was the one way a card reached staging without the owner's Implement: a "no" on its closing "Prototype round first?" question staged it, so the owner approved a build by answering a question about prototypes. The owner asked for a question about building instead, and for no ticket question. Owner's answers: one closing question, Implement / Prototype first / Keep discussing; cards whose grill already asked the old question keep it.

Supersedes the question of [every grill ends with a prototype question](2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md); the board still acts on the answer with no orchestrator step, and [a grill still waits for every answer before it changes phase](2026-11-07-1213-a-grill-waits-for-every-answer-before-it-changes-phase.md).

## Decision

- **The question.** Every grill ends with "What next, given these answers?", flagged `"next_gate": true` in its `question add --file` entry, options `implement` ("Implement"), `prototype` ("Prototype first") and `discuss` ("Keep discussing"), in that order. Implement is recommended when the grill settles the card and it doesn't change the hub's or a board's UI, Prototype first when it does. It is asked even when it is the grill's only question. `question add` refuses other options, a question setting both `prototype_gate` and `next_gate`, and a `next_gate` on a card that keeps its prototype answer. `question settle` refuses it, as it does the old one: it is the owner's.
- **The answer.** Implement keeps `gates.prototype` `no` and Prototype first keeps `yes`, the facts the old question's no and yes keep ([a card's gates are facts it keeps](2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md)), so once nothing is left open the card stages or moves to prototyping exactly as before, and a regrill asks neither question. Keep discussing keeps `gates.next` `discuss`; once nothing is left open `moveOnAnswered` returns the card to discussing, starting nothing, and spends it, so the card's next grill asks the closing question again. A stage spends it too (an Implement tap before the grill's other answers), so it never outlives the grill it answered.
- **Old questions.** `prototype_gate` stays a gate: an open one decides the card as it did, and an answer to either question resolves any other open question of the two on the card. The start-up backfill (`migrateGates`) reads only the old question; a `next_gate` answer is kept as it is given.
- **No ticket question.** The grill brief says never to ask whether to make a ticket: [tickets are made at ready](2026-11-10-1600-tickets-are-made-at-ready.md).

The brief's wording is in board/headless.mjs (`plannerBrief`), the gate in board/store.mjs (`GATES`), and SKILL.md teaches the same.
