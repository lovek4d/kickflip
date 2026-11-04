---
status: superseded in part by 2026-11-02-1700-a-confirm-waits-for-claudes-update and 2026-11-03-0504-a-prototype-pick-is-the-builds-go
---

# A pick with no note settles a prototype round

Superseded in part by [a confirm waits for Claude's update](2026-11-02-1700-a-confirm-waits-for-claudes-update.md): a pick with a note opens no confirm until the session runs `question confirm` on the updated take, and `question resolve --no-change` settles one whose note needed no change.

The owner asked on hub/INT-256 that a pick with no note on a prototype question need no "Is this it?" confirm: "no note selection should not require a confirmation single prototype flow". A pick with no note already is the take, so the confirm only asked the owner the same thing twice. They added: "answering a question with note only should also resolve it". This amends [a prototype round ends with a one-take confirm](2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md).

- **A pick with no note settles the round.** An owner answer that picks one of a prototype question's takes with no note opens no confirm (`store.mjs` `openConfirm`). The question stays answered, waiting on Claude, and the topic's head reads "Round N closed · take X" (`domain.mjs` `roundSettledBy`).
- **A pick with a note still opens the confirm.** The note may change the take, so the board opens the one-take confirm as [a prototype round ends with a one-take confirm](2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md) describes, and any answer to that confirm settles the round. [A prototype answer with a note gets a confirm round](2026-11-01-1514-a-prototype-answer-with-a-note-gets-a-confirm-round.md)'s building gate is unchanged.
- **The newest settling answer decides.** A round is settled by the newest of two kinds of answer: a question's last answer when it picks a take with no note, and any answer to the round's confirm. A later noted pick on the same question opens a confirm, and the round waits on it again.
- **A note with no take resolves its question.** An owner answer with a note and no take, on any question, confirms included, resolves that question, noting "Answered with a note" (`store.mjs` `resolveNoteAnswer`). It leaves Needs you and opens no confirm. The session still gets the owner-answer event, with `choice: null` and the note, to act on.
- **`question resolve` follows the round.** It refuses a question on a prototype page until an answer settles its round, naming the round's open confirm when it has one. It accepts a question that is already resolved and changes nothing, as for one a note resolved.

A note with no take on a round's own question doesn't settle the round, since it picks nothing; the session posts the next round with `round_of` as before. A note with no take on a confirm settles the round with no take, as an answer to the confirm did under [a prototype round ends with a one-take confirm](2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md), and the building gate then holds the card until the session follows the note.
