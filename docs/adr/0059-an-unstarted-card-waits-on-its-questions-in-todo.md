# An unstarted card waits on its questions in Todo, and its one action button follows what it waits on

A card that hasn't started and waits only on the owner's answers, open questions or a prototype pick, stays in **Todo** with its Action needed badge, ask and work card alike. Answering moves it on: a work card goes to In Progress as its work starts, and an ask goes to In Progress while Claude takes up the answer. In Review keeps finished work waiting on the owner or the reviewers: a green draft's Ready, Merge, manual steps and an answered ask waiting on its Done ([0045](0045-the-lane-follows-who-acts-next.md)).

- **Started.** A work card is started once one of its questions is answered or resolved, or a builder has worked on it (`board/domain.mjs` `started`). A started card that gets a new question keeps its lane: In Progress, with Action needed, when nothing else places it ([0049](0049-a-started-card-never-returns-to-todo.md)).
- **An ask with an open question is never Done.** An ask Claude replied to while a question on it (topic `item:ask:<event id>`) is open is a Todo card reading Task, with no bump or edit, carrying Action needed and its thread's Done. Once the owner answers, it sits in In Progress until Claude replies to the answer, then goes to Done. The owner's Done, `ask done` and `ask progress` decide it ahead of its questions ([0035](0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)). A New card asked a question, such as whether to move it, stays a New card in Todo.
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

This narrows [0045](0045-the-lane-follows-who-acts-next.md) on where an owner's wait sits, [0047](0047-the-plus-makes-a-new-card.md) on an answered ask going to Done, and [0049](0049-a-started-card-never-returns-to-todo.md) on when a card counts as started.
