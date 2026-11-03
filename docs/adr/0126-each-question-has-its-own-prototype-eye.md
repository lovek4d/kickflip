# Each question has its own prototype eye

The owner asked on hub/INT-267 for the prototype eye to leave Waiting on you's Send bar, where it crowded the ⌘↵ hint and asked for whichever question was last touched, and to sit on each question instead. This amends [0111](0111-a-prototype-round-ends-with-a-one-take-confirm.md)'s eye beside Send.

- **One eye per question.** Each open, answered or replied question's note row starts with its attach button and then its eye (`board/public/ui-questions.js` `questionCard`), in the order of a card thread's reply row. The eye sends `prototype-request {key?, question, note}` for that question alone, with its note box as the note; `key` is the card when the question's topic is `item:<key>`.
- **A requested question's eye waits.** A question that reads Prototype requested shows the eye's "…" and takes no tap. A resolved question has no eye.
- **The Send bar keeps ⌘↵ and Send.**

A card's thread keeps its own eye, which asks for prototypes of the card ([0015](0015-prototypes-come-on-request.md)).

Considered: the same eye on each question with no eye in a card's thread (take A of `proto-eye`). The owner chose take B, with both icons moved to the left of the question's row.
