# Needs you is a deck on a phone and a pane on a desktop

Needs you looks different on each width. Card #248 (needs-you-shell-notes.md) came out of five prototype rounds, questions-shell to questions-shell-5.

**On a phone (below 900px), Needs you is a deck at the top of the board** (`#needsDeck`, `board/public/app-needs.js`). It shows one thing at a time. A question's options are buttons, and a tap sends that answer at once as `owner-answers`. A pending prompt shows its own Allow / Deny or option buttons (`prompts.js`). Any other line, such as Ready on GitHub, an Action needed, a held review or a wave, shows its action as a button. Skip moves to the next thing and wraps round after the last. There is one dot per thing waiting. "All open questions · N" at the foot opens Waiting on you. A question whose url is a prototype page has a **View prototypes** button that opens that page. The deck tracks what it shows by id, so an arrival adds a dot, the card on screen stays as it is, and the repaint goes through `setHTML`.

**From 900px, the board splits in two.** The lanes are on the left. On the right is a sticky pane (`#needsPane`) holding the Needs you lines (`#waiting`, as before) over Waiting on you. Waiting on you is mounted there with `markup({embedded: true})` and `ctx.embedded`, so it has no header, never writes the board's hash and never scrolls the window. It is mounted while the width matches and unmounted when the width drops below 900px.

**Arrivals on Waiting on you land in place** (`view-questions.js` `arrive`). Sometimes a load changes only the topics, their counts, or adds open questions at the end of the shown topic. Then each existing pill keeps its node, and a new pill is inserted at its place in the row. A new question's card goes after the last open card. The topic line, the Waiting on Claude and Resolved folds (each keeping its open state) and the bar update. Any other change repaints as before, and it still waits while a note is being typed. So the open topic, its picks, the note being typed and the scroll all stay.

The owner, on gh248-shell, chose C, one inbox off its own page, and asked for a split on desktop. On gh248-shell-3b they said desktop "looks pretty good", and wanted a phone to keep Needs you at the top, linking to the Open questions page. On gh248-shell-4 they wanted a fresh take, keeping no-reload arrivals. On gh248-shell-5 they picked A, the triage deck, and said anything with a prototype gets View prototypes. The fuller prototype viewer, which also keeps questions apart from prototypes, is #287.

Considered:
- **A Board / Needs you switch, or a pull-up sheet, on a phone** (round 3). The owner set both aside: no sheet and no switch on a phone.
- **Grouped by ask, or flags on the cards** (round 5 B and C). The owner picked the deck.
- **Picking in the deck as a draft that Send on the questions page sends** (the round 5 drawing). A tap that sends at once is what "answered in place" means, and a one-question answer needs no Send.
