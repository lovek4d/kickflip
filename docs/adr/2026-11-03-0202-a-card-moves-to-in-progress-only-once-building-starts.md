# A card moves to In Progress only once building starts

This supersedes in part [any work on a card starts it](2026-11-02-2000-any-work-on-a-card-starts-it.md), [an unstarted card waits on its questions in Todo, and its one action button follows what it waits on](2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md) and [a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md) on when a work card counts as started.

Todo holds every work card that hasn't started building, where its Build shows ([a Todo card that nothing blocks has Build](2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md)). A work card is started, and leaves Todo for In Progress, once any of these is true:

- it has a build agent's builder record, running or finished: any kind but `grill` and `prototype`, so `build`, `opus` and `codex`, and a record with no kind;
- its status is `building` or `fixing`.

`checking`, a PR and a pushed branch already place a card on their own (`laneOf` in `board/domain.mjs`). `started` in `board/domain.mjs` derives the rest.

- **Discussion stays in Todo.** An answered, replied or resolved question, a running or finished grill or prototype agent, a working mark on a message in its thread and a prototype recorded for it all leave the card in Todo with its Build. A running grill or prototype agent still shows its status line on the card.
- **A started card never returns to Todo.** A finished build agent keeps the card In Progress when nothing else places it, as before; Held is still the only way back ([a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md)).
- **Done reopens to In Progress.** An owner message or a new question on a Done card that hasn't merged still reopens it to In Progress, not Todo ([a message or question on a Done card reopens it until the owner's Done](2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md), [a card waiting only to be closed has no Action needed](2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md)).
- **The idle pull.** A board with a running agent of any kind, grill and prototype included, isn't idle, so nothing is pulled while one runs ([an idle board pulls in its top Todo card](2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md)). A Todo card with a message a session is working on isn't pullable, which [any work on a card starts it](2026-11-02-2000-any-work-on-a-card-starts-it.md) got from moving that card out of Todo.
- **Asks** keep their own lanes ([an ask can wait on the owner before Done, and the owner closes any open card from its thread](2026-10-29-1639-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)).

The owner asked for this on #59's thread: "Anything that is in progress should only be in progress because it started building. … These have not started building. They had questions, there was discussion. They should still stay in to do because in to-do there is a build button". And earlier, on #50: "it should stay in to do until building begins. The in-progress reversion from done is specifically for done. If something is done and then it's getting messages again, that's now in progress. But it's not going all the way back down to to-do."

Considered:
- listing only `build`, `opus` and `codex` as build kinds: older records have no kind, and other agents a session starts on a card, such as a benchmark, are building;
- skipping a card with a running grill or prototype agent in `pullOf` itself: the idle check already holds every pull while any agent runs.

Superseded in part by [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): a build's start stores the move to In Progress; there are no building or fixing statuses.
