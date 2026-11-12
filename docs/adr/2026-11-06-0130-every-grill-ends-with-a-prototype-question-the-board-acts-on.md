# Every grill ends with a prototype question, and the board acts on its answer

The grill planner asked for a prototype round only when the card changed UI, and acting on the answer was left to the orchestrator. Now every grill ends with "Prototype round first?", options yes and no, flagged `"prototype_gate": true` in its `question add --file` entry. Yes is recommended when the card changes UI, no otherwise. It is asked even when it is the grill's only question, so the card then waits on it.

The board acts on the answer (store.mjs settleGates, called from the server's recordAnswers), with no orchestrator step. The question resolves at once. Yes moves a grilling card to prototyping and starts the prototype planner. No moves it to ready once none of its questions is left open, as the grill end of the [nothing-left-to-ask ADR](2026-11-05-0226-a-grill-with-nothing-left-to-ask-ends-ready.md) does; the check reruns on every later answer on the card, so the order of answers doesn't matter. A card that no longer reads grilling is left alone. If ready is refused (no size, or notes that leave out an answered question), the card stays and a thread line says why.

The planner never sets a card ready itself any more; where the owner asked for prototypes, or a rule wants a UI prototype first, it still ends the card prototyping and skips the question. The brief's wording is in board/headless.mjs, and SKILL.md teaches the same.

A gate answered with no note needs no mention in the card's notes for ready (checkNotesComplete); the answers to the other questions still do.

From #320, related to #319 (a grill's questions land together).

Amended by [a grill waits for every answer before it changes phase](2026-11-07-1213-a-grill-waits-for-every-answer-before-it-changes-phase.md): yes moves the card only once none of its questions is open.

Amended by [a card's gates are facts it keeps](2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md): the answer stays on the card as gates.prototype, so a later grill never asks it again, and a yes is spent once the card moves to prototyping on it.

Superseded in its question by [a grill ends asking to implement, prototype or discuss](2026-11-12-1400-a-grill-ends-asking-to-implement-prototype-or-discuss.md): the closing question is "What next, given these answers?", and the board acts on its answer the same way.
