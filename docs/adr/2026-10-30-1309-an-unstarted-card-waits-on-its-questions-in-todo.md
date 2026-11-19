---
status: superseded in part by 2026-11-02-2000-any-work-on-a-card-starts-it, 2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts and 2026-11-03-0259-answered-asks-have-their-own-section-below-done
---

# An unstarted card waits on its questions in Todo, and its one action button follows what it waits on

Superseded in part by [any work on a card starts it](2026-11-02-2000-any-work-on-a-card-starts-it.md) on when a work card counts as started: a builder record of any kind, a working mark on a message in its thread or a prototype recorded for it also starts it.

Superseded in part by [a card moves to In Progress only once building starts](2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md): an answered or resolved question no longer starts a work card; it stays in Todo with its Build until building starts.

Superseded in part by [answered asks have their own section below Done, and Done and Asks show 10 cards at a time](2026-11-03-0259-answered-asks-have-their-own-section-below-done.md): an ask whose questions are answered stays in Todo while Claude takes them up, and goes to Asks, below Done, once closed.

A card that hasn't started and waits only on the owner's answers, open questions or a prototype pick, stays in **Todo** with its Action needed badge, ask and work card alike. Answering moves it on: a work card goes to In Progress as its work starts, and an ask goes to In Progress while Claude takes up the answer. In Review keeps finished work waiting on the owner or the reviewers: a green draft's Ready, Merge, manual steps and an answered ask waiting on its Done ([the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md)).

- **Started.** A work card is started once one of its questions is answered or resolved, or a builder has worked on it (`board/domain.mjs` `started`). A started card that gets a new question keeps its lane: In Progress, with Action needed, when nothing else places it ([a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md)).
- **An ask with an open question is never Done.** An ask Claude replied to while a question on it (topic `item:ask:<event id>`) is open is a Todo card reading Task, with no bump or edit, carrying Action needed and its thread's Done. Once the owner answers, it sits in In Progress until Claude replies to the answer, then goes to Done. The owner's Done, `ask done` and `ask progress` decide it ahead of its questions ([an ask can wait on the owner before Done, and the owner closes any open card from its thread](2026-10-29-1639-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)). A New card asked a question, such as whether to move it, stays a New card in Todo.
- **One action button.** `buildBoard` sets `actionButton` on every card, and `board/public/app-cards.js` only maps it to a label and an event:
  - `openQuestions`, reading **Open questions**, while the card has open questions or a prototype pick, held or not. It opens the first on `questions.html`.
  - `markDone`, reading **Mark as done**, on an ask waiting only on the owner's Done. It confirms and sends the same `ask-done` as the thread's Done, which stays beside Send.
  - `grill`, reading **Grill**, or "Writing questions…" while a grill waits on Claude.
  - `null` on a Done card, and on an ask with neither questions nor a Done to wait on.

  Open questions win over Mark as done: a card with an open question can't be done. An open ask shows its button above its thread.

The iOS session replied to an ask and added a question on it, and the board put the ask in Done, since a reply counted as the answer whatever was still open. A work card waiting on its first questions went to In Review, beside finished work. The owner asked that "a new task goes to be a todo if there are any follow ups, and then when follow ups are answered it updates to in progress as implementation kicks off".

The owner picked Todo for every card not yet started on hub/INT-130 (question `questions-lane`), and asked for one action button the domain derives by kind, named Open questions rather than Open items.

Considered:
- Todo for New cards only, with a work card being grilled still in In Review (`questions-lane`), which puts two cards waiting on the same kind of answer in different lanes;
- the page choosing the button from the card's fields, a chain of conditions no test pins to a case.

Every Todo work card shows the Questions button, so its place in the workflow row doesn't depend on a question having been asked; with none ever asked it is disabled (title "No questions yet").

This narrows [the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md) on where an owner's wait sits, [the + makes a New card, which Claude files, folds or answers](2026-10-29-1639-the-plus-makes-a-new-card.md) on an answered ask going to Done, and [a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md) on when a card counts as started.
