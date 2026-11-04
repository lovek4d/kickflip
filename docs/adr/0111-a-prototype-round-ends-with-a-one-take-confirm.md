---
status: superseded in part by ADR-0114, ADR-0116, ADR-0126 and ADR-0150
---

# A prototype round ends with a one-take confirm

Superseded in part by [0114](0114-a-pick-with-no-note-settles-a-prototype-round.md): a pick with no note settles the round and opens no confirm, and a note with no take resolves its question.

Superseded in part by [0116](0116-a-confirm-waits-for-claudes-update.md): a pick with a note opens no confirm by itself; the session opens it with `question confirm` once it has updated the take.

Superseded in part by [0126](0126-each-question-has-its-own-prototype-eye.md): the eye moves from beside Send onto each question, and asks for that question alone.

The owner asked on hub/INT-221 to ask for a prototype from an open question, in place of an answer, and that a prototype round always ends with a single-take confirm that the board's code enforces, not the skill's wording.

- **The eye beside Send.** Waiting on you puts the board's eye button (`BoardUI.protoButton`) left of Send. It sends `prototype-request {key?, question, note}` for the question last typed in or picked on, else the first one not resolved or requested, with its note box as the note; `key` is the card when the question's topic is `item:<key>`. The thread's eye still sends `prototype-request {key}` ([0015](0015-prototypes-come-on-request.md)).
- **Requested.** Superseded by [0177](0177-a-question-asked-for-a-prototype-is-resolved.md): the request resolves its question. ~~A question with a `prototype-request` newer than its last answer is `requested` (`board/domain.mjs` `ownerQuestion`): its card shows that it is requested ([0126](0126-each-question-has-its-own-prototype-eye.md) has the look), its options and note are off, and it counts as waiting on Claude, not open. It stays so until it is resolved.~~
- **Rounds are data.** A question's round is owner.json's `round`, else 1 on a prototype page and 0 elsewhere (`roundOf`). `question add` with `round_of: <question id>` on the same topic, with a prototype url, numbers the new question one past that question's round and resolves that question, noting "Followed by prototype round N". The eye on a round question therefore starts round N+1. A topic's head shows its latest round: "Prototype round N" orange with a spinner while a question's request waits on its round ([0177](0177-a-question-asked-for-a-prototype-is-resolved.md)), blue while the round is back, and grey "Round N closed · take X" once the round's confirm has an answer.
- **The board opens the confirm.** An owner answer that picks one of a prototype question's takes makes the board server add "Is this it?" on the same topic, round and prototype, offering that take alone (`store.mjs` `openConfirm`), with a link to the take at `?take=` and the line "A prototype round ends with a one-take confirm". It resolves the answered question, noting "Followed by Is this it?", and replaces an open confirm on the topic. An answer to a confirm opens none. The session never writes a confirm.
- **Only the confirm's answer closes a round.** `question resolve` refuses a question on a prototype page until a confirm in its round has an answer, in one line naming that confirm. The board's own resolutions (followed, replaced, closed with the card, recorded in notes) are unchanged.

[0091](0091-a-prototype-answer-with-a-note-gets-a-confirm-round.md)'s building gate still reads the newest answer to a card's prototype questions, which is now the confirm's.

Considered: an eye beside each option, asking for a prototype of that option alone (take B of `prototype-rounds`). The owner chose one eye beside Send (take A).
