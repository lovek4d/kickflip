# Implement is only the card's tap

Card #1003 (T-660). Owner, on T-651 (11/17): "again implement should be done at a ticket action level, not as a
question choice. And it appears the question still doesn't reliably mark staged, so we should stop that path". A grill's
closing next_gate question, answered Implement, had left its card discussing and unstaged, and the board opened a wait
on it.

Supersedes [a grill ends asking to implement, prototype or discuss](2026-11-12-1400-a-grill-ends-asking-to-implement-prototype-or-discuss.md)
and [an Implement option is only a last-wave closing question](2026-11-17-2100-an-implement-option-is-only-a-last-wave-closing-question.md).
[A final visual ends on the card's Implement](2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md) stands.

## Decision

- **No question offers Implement.** `question add` and `--questions` (checkQuestions, board/questions.mjs) refuse any
  question with an option whose id is `implement` or whose label starts with the word "Implement", and `next_gate` is
  an unknown field. The next_gate gate, its implement/prototype/discuss options, its staging on an Implement answer and
  `gates.next` (Keep discussing) are gone.
- **A grill ends on the card's Implement ask.** The grill planner's last step, after its questions, is
  `thread <key> --implement`, which marks the grilling card waiting on Implement. The brief (board/headless.mjs
  plannerBrief) says so; a card that keeps a prototype yes ends with no ask, and the board moves it to prototyping.
- **The ask carries the card back to discussing.** Once none of the card's questions is open (moveOnAnswered), or as a
  grill that asked nothing finishes (stopPlanner), a grilling card its grill's ask waits on (asksImplement) returns to
  discussing and is marked again there, so the card reads Tap Implement. Only the owner's tap stages it.
- **A prototype no is not Implement.** An older card's `prototype_gate` answered no keeps gates.prototype no and marks
  the card waiting on its Implement ask (settleAnswers), so it too returns to discussing once nothing is open, unstaged.
- **A grilling card's last answer never stages it (#1081, owner 11/18: "we have moved away from questions to implement,
  it should at most mark the next as implement").** Once none of its questions is open, moveOnAnswered sends any
  grilling card to discussing and marks its Implement ask waiting there, whether or not its grill posted `thread
  --implement`. Only the owner's tap stages it. A card in another phase stays where it is, and the staging branch of
  moveOnAnswered is gone. This replaces the earlier rule that a grilling card with no ask staged once answered.
- **Old data.** At boot the `no-next-gate` migration (dropNextGates, board/migrations.mjs) resolves each unresolved
  next_gate question with a note in its card's thread, marking the card waiting on Implement where it still owes one,
  drops staged ones, and drops `gates.next` from every card. An answered next_gate question still needs no line in the
  notes before ready, as a gate question.

## Consequences

- An owner message on a grilling card clears its Implement ask, as it clears any mark; once answered, that card still
  goes to discussing with the ask marked again.
- The prototype planner posts no Implement ask: a take pick owes a final visual, which ends on the card's Implement.
