# A prototype answer with no pick prototypes again, so a card is never stuck

The owner, on #60's thread: "if that happens and no take is picked, you must create another prototype. Another prototype is the way out. You shouldn't be stuck if you're waiting for any for an answer. There should always be either a ready grill or prototype or one of those pending." #60's newest prototype answer picked no take, only a note; the Build gate ([a prototype pick is the build's go, and more of the skill moves into code](2026-11-03-0504-a-prototype-pick-is-the-builds-go.md)) refused, and the card read "No take picked, so it isn't ready to implement" with nothing moving it on.

- **The card prototypes again.** While the newest answer to a card's prototype questions picks no take (`board/domain.mjs` `noTakePicked`), the built card reads state prototyping and, with nothing waiting on the owner, Next "Prototype again" (`PROTOTYPE_AGAIN`). Both are derived, not stored, so the next round's pick ends them with no write.
- **The answer says so.** The board server records such an answer (`picksNoTake`: a card's question linking a `prototype-*.html` page, answered with none of its takes) with `prototype_again: true` on its `owner-answer` event, the event that already wakes the session. The session draws the next round from the note as for a `prototype-request`, or grills when the note asks a question; which one is the session's read of free text.
- **The gate names the way out.** `item set --status building` refuses with "…, so it prototypes again: draw the next round from that note, or grill when the note asks a question, and build once a take is picked", and the Implement tap with "no take is picked on its prototypes, so it prototypes again. Pick a take from the next round, then tap Implement."
- **The idle board can plan it.** `pullOf`'s plannable takes a card prototyping again with nothing waiting on the owner as it takes an unready buildable card ([the idle pull takes ready cards first, and plans the top card when none is ready](2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md)), so a missed wake still ends in `card-plan`. Once the next round is open, its question keeps the card off the list.

So a card always has a ready build, a pending grill, or a pending prototype.

Considered:
- storing `state: prototyping` and a Next on the item: a write in the answer path that the next round's pick would have to undo;
- a separate `prototype-again` event: a second wake for the one answer the session already reads.
