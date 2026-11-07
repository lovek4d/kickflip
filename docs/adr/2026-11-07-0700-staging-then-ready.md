# Staging, then ready

Status: accepted

Supersedes [Implement in the thread queues the card for the orchestrator](2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md) and [a grill with nothing left to ask ends ready](2026-11-05-0226-a-grill-with-nothing-left-to-ask-ends-ready.md). It replaces in part [Todo has no queue](2026-11-05-0802-todo-has-no-queue.md) (the release of an Implement-asked card), [every grill ends with a prototype question the board acts on](2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md) (a "no" stages in place of ready), [every card arriving in Todo is grilled by the board](2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md) (quick follow-ups filed `item add --state ready`) and [a new card is ready, grilling or prototyping](2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md) (the three states).

The owner asked (11/05) for "a stricter build beginning process enforced in code": "staging is a state that is set by a user input, user button click … And then the agent can freely move cards between staging and ready. And maybe that can simplify a lot of our other checks."

A card's state is now `grilling | prototyping | staging | ready`.

- **Only the board sets staging**, on an owner action. `item set` and `item add` refuse `--state staging`.
  - A Send that leaves an unstarted card with nothing open stages it: a gate "no", a note-only answer, a held or blocked card included. It doesn't when no take was picked, a planner or build runs on the card, or a gate "yes" moved it to prototyping.
  - An Implement with text on a Todo card stages it in Todo, unholds it and resolves its open questions "Skipped: you tapped Implement". A bare Implement on any Todo card marks it ready as it is and starts the build ([a button without a text box posts a keyed status line](2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md)).
  - A Reply on a ready card stages it.
- **Code writes the owner's words into the card's notes**, verbatim, under a dated heading, making `<id>-notes.md` when the card has none. The owner, on gh297-fold: code writes the answers in, and the orchestrator only judges.
- **`--state ready` is taken only from staging**, or on a card already ready. A Quick build ask filed `--from-ask` counts as its staging (gh297-quick). `item add --state ready` is refused: an agent's card lands in Todo and is grilled (gh297-agent-ready).
- The orchestrator's wait on a staging card is "Judge the staged card". Moving a staging or ready card back to grilling or prototyping records `round_at`, and the board launches that round's planner (`roundsDue`, `launchRounds`).
- **Ready means the card can be pulled**, with no queue order: "simpler, its just a staging and ready. all ready cards are ready to be pulled in, that's it" (owner, round 2). The pull reads `buildable && state === 'ready' && !held && !blockedBy.length`. A question added on a ready or staging card, or a Grill or Prototype tap on one, moves it to grilling or prototyping, so a ready card never has one open.
- The footer reads an orange `staging` where ready reads green (round 3, take A).
- Server start moves each card with `implement_at` to staging at that time; a card already ready stays ready.

Checks this replaces: `implement_at` and `askImplement`, the release that started an Implement-asked card at once (`startReleasedBuild`, pullOf's `starts`), `startedByAnswer` and the `card-unblocked` event on an answer, the `implement` orchestrator wait, and the pull's own question and planner checks. `checkNotesComplete` stays, as the gate out of staging.

Amended by [every lane has phases](2026-11-11-1200-every-lane-has-phases.md): `state` is now `phase`, and staging and ready are phase words at the end of the footer.
