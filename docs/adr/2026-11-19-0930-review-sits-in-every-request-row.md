# Review sits in every request row

The owner asked for Review on the New task box and on open questions, through the one helper that already draws the row (`ui.js requestRow`), not a second copy. This amends the last line of [/review in a thread launches a reviewer](2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md), which kept Review to a thread's reply box, and its "thread word only" rule for /review.

- **One row.** `requestRow` always draws Prototype, Grill, Visual and Review; the opt-in `review` flag is gone. `slashOf` reads /review in every box.
- **New task.** Its Review (or /review in the text) sends the ask with `request: 'reviewer'`, a brief kind like the others (`BRIEF_KINDS`), so the filed card owes a reviewer brief with the task's text and files, as a Grill does. The hub's `/_hub/route` accepts it.
- **Question.** Its Review sends `review-request {key, question, note, choice}`, which the board already takes for a question: the reviewer brief asks for a review of what the question is about. The question stays open, as with a visual.
