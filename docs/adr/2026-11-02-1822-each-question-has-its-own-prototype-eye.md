# Each question has its own prototype eye

The owner asked on hub/INT-267 for the prototype eye to leave Waiting on you's Send bar, where it crowded the ⌘↵ hint and asked for whichever question was last touched, and to sit on each question instead. This amends [a prototype round ends with a one-take confirm](2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md)'s eye beside Send.

- **One eye per question.** Each open, answered or replied question's note row starts with its attach button and then its eye (`board/public/ui-questions.js` `questionCard`), in the order of a card thread's reply row. The eye sends `prototype-request {key?, question, note, choice}` for that question alone, with its note box as the note and its pick so far (its draft's, else its last answer's, else null) as the choice; `key` is the card when the question's topic is `item:<key>`.
- **A requested question's eye waits.** Superseded by [a question asked for a prototype is resolved, and the page moves on](2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md): the tap resolves the question and the page moves on. ~~Once the eye is tapped (hub/GH-120, take A of `proto-requested-2`), the question's eye is off and a "prototype requested" badge with a spinner sits right after it, in the accent, the owner's colour, not the builder's orange; the card has no other requested line or header badge. The card takes a faint accent tint and an accent border drawn inside it (an inset shadow on the unchanged 1px border), so it keeps its size. Its options and note are off and show the pick and note the request was sent with, until the round arrives.~~ A resolved question has no eye.
- **The Send bar keeps ⌘↵ and Send.**

A card's thread keeps its own eye, which asks for prototypes of the card ([prototypes come only when obviously helpful or on request](2026-10-29-1639-prototypes-come-on-request.md)).

Considered: the same eye on each question with no eye in a card's thread (take A of `proto-eye`). The owner chose take B, with both icons moved to the left of the question's row.
