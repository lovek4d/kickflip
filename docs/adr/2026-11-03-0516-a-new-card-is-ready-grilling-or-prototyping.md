# A new card is ready, grilling or prototyping, and reads ready in green when it is

An ask the session files as its own card (`item set --from-ask`) is in exactly one of three **card states**, which the session picks and the board enforces: **ready**, **grilling** or **prototyping**. Folding an ask into a card, moving it to another board and answering it as a question stay as they were ([the + makes a New card, which Claude files, folds or answers](2026-10-29-1639-the-plus-makes-a-new-card.md), [answered asks have their own section below Done, and Done and Asks show 10 cards at a time](2026-11-03-0259-answered-asks-have-their-own-section-below-done.md)); only an ask that becomes its own card gets a state.

**The session sets it, the board holds it.** `item set <key> --state ready|grilling|prototyping` writes `state` on the wave entry, in the same call as `--from-ask` or later. It refuses any other state, and refuses ready while the card has an open question: ready means the notes leave the owner nothing to decide. The plan lives only in the card's notes (`--notes-file`), never on the card.

**New until it has one.** An unstarted Todo card with `from_ask` and no state is `unsorted` (`board/domain.mjs`) and shows its ticket id like any card; New is only on an ask ([New shows only on an ask](2026-11-05-1632-new-shows-only-on-an-ask.md)). Cards not made from an ask need no state.

**ready on the time line.** The time line reads: time · held (until …) · blocked by #N · then Action needed (orange) or ready (green) · N new messages (blue). `ready` shows on an unstarted Ready card that nothing blocks and that has no Action needed; held may show beside it (`board/domain.mjs` `ready`, `board/public/ui-cards.js` `timeLine`).

**Auto-build is the idle pull.** A Ready card is pullable by "Pull in Todo cards when idle" like any settled card ([an idle board pulls in its top Todo card](2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md)). A card still New, grilling or prototyping is not (`pullOf`).

**Grill reads Writing questions… while a grill is under way.** The card's Grill button is disabled and reads "Writing questions…" while a Grill tap waits on its reply, while a grill agent runs on the card, and while a dispatch has not finished; a card merely left at state grilling with none of those is not under way, and the idle board plans it (#184). Once questions are posted it is Open questions as before.

The owner, on the ask: "one of three things should be happening. It should be saying ready to build, or it should be grilling, or it should be prototyping", "let's maybe aim for not putting this in the skill, but building it into the application itself", and in the grill "The card should just show new until it has a status". On the look: "I don't want the plan visible on the to-do item itself. Just give me a ready text that goes after the orange but before the blue new message in the time row ... And when it's ready, it can be green." On Grill: "When a grill has been started, the grill button should be disabled, including if the grill was started by the task landing and being triaged into a grill state."

Considered:
- a Next line "Ready: <plan>" on the card: the owner wanted the plan off the card;
- the app classifying the ask with its own model call: the board's own session already reads it, so it picks and the board enforces;
- a separate auto-build setting for Ready cards: "Pull in Todo cards when idle" already starts settled cards;
- requiring a state on every Todo card: cards imported or added without an ask have no intake to sort.
