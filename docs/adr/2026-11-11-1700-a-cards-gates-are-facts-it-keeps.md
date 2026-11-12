# A card's gates are facts it keeps

Card #532 (T-96), from the owner's question on #508: "could this have a more high level general solution?" The board asked a card's gate questions ("Prototype round first?", and before T-100 "Create a ticket for this task?") on every grill round, whatever was already known: a regrill re-asked the prototype question (T-8), and each split child re-asked both, so the orchestrator re-added them pre-checked by hand. Owner's answers: one field on the card, `gates`; a new `item add --split-of <card>` that copies them; a yes is spent once its round runs, and a regrill then stages.

Amends [every grill ends with a prototype question](2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md) and [a grill can propose a split](2026-11-07-1216-a-grill-can-propose-splitting-its-card-into-a-wave.md).

## Decision

- **The fact.** A card keeps `gates: {prototype?, ticket?}`, each `yes` or `no`, from the owner's answer to its gate question (`settleAnswers` → `keepGate`). Since [tickets are made at ready](2026-11-10-1600-tickets-are-made-at-ready.md) the ticket gate only records answers to older questions; the prototype gate does the work.
- **A yes is spent.** `moveOnAnswered` moves a grilling card with `gates.prototype` yes to prototyping and writes it `ran` in the same step. A later grill on the card reads `ran` like `no`: it stages.
- **The grill asks only what is unset.** `briefFacts` gives the planner the card's `prototype`; with one set, `plannerBrief` drops the closing question and says where the board will move the card. `question add` refuses a gate question whose fact is set (`checkGateFact`, which keeps the old ticket refusals).
- **One resolve rule.** A gate whose fact is set has no question: `resolveGate` resolves the card's other open questions of that gate and drops a staged one. A linked ticket goes through it too.
- **A grill with nothing to ask.** `stopPlanner` moves a grilling card that keeps a prototype answer on (`moveOnAnswered`) when its grill ends asking nothing, instead of the `planner-unasked` fault. A card with no answer kept still faults.
- **Split children.** `item add --split-of <card>` sets the card as Parent and copies its `gates`. Plain `--parent` copies nothing, so a follow-up is grilled fresh. The two can't be passed together.
- **Backfill.** `migrateGates`, run as the board server starts, gives each card not in Done with no `gates` the newest yes or no answer to each of its gate questions. A prototype yes reads `ran` once the card is past grilling or its thread has the `prototype-round` line after the answer. Cards with `gates` are left alone, so it runs once in effect.

## Not done

- A split child's ticket on a parent's yes: tickets are made at ready now.
- No CLI sets a gate by hand; the owner's answer and `--split-of` are the only writers.
