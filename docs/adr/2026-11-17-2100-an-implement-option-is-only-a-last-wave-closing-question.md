# An Implement option is only a last-wave closing question

Owner, 11/17 on T-606: after a final visual the card asks for the Implement tap, not a "Build it as shown?" question. An
Implement option belongs only to the closing question of a last-wave series, a grill's next_gate, and choosing it
stages the card.

- `question add` and `reply --questions` (checkQuestions in board/store.mjs) refuse any question that is not a
  next_gate and has an option with id `implement` or a label starting with the word "Implement".
- A next_gate Implement answer keeps gates.prototype no (keepGate) and, once every question on the card has an answer,
  moveOnAnswered stages the card. It already did; board/next-gate.test.mjs covers it.
- SKILL.md and the grill planner brief (board/headless.mjs) say so. The visual side, a final visual ending on the card's
  Implement, is 2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md.
