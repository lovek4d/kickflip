---
status: superseded in part by 2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping and 2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts
---

# Any work on a card starts it

Superseded in part by [the CLI and board server do the board's housekeeping](2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md): the watcher writes the working mark as it prints the message, not `board.mjs working`.

Superseded in part by [a card moves to In Progress only once building starts](2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md): only building starts a card, a build agent's record or a building or fixing status. A grill or prototype agent, a working mark and a recorded prototype leave it in Todo with its Build.

Todo holds only cards nobody has touched since they were filed. A work card is started, and leaves Todo for In Progress, once any of these is true:

- one of its questions is answered or resolved ([an unstarted card waits on its questions in Todo, and its one action button follows what it waits on](2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md));
- it has a builder record of any kind, `--kind prototype` and `--kind grill` included, running or finished;
- a message in its thread, an item message, an owner answer or another card event, has a `board.mjs working` mark;
- a prototype is recorded for it with `prototype add --card <wave>/<id>`.

`started` in `board/domain.mjs` derives this from records that already exist: builder records, `data/working.json` and `data/prototypes.json`. Nothing writes the wave file. The board server reads both files into every snapshot it builds lanes from, so the idle pull ([an idle board pulls in its top Todo card](2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md)) and Build ([a Todo card that nothing blocks has Build](2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md)) skip a card a session is already working on.

- **Asks don't count.** A working mark on the ask a card was made from or folded in is the session sorting the ask, not work on the card, so the new card still starts in Todo.
- **Leaving In Progress.** A started card leaves the usual ways: a running builder, a PR, an owner wait ([the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md)) or Done. A new question on it keeps its lane with Action needed, as on any started card ([an unstarted card waits on its questions in Todo, and its one action button follows what it waits on](2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md)). Held is still the only way back to Todo ([a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md)).

hub/INT-255 sat in Todo while an agent built its prototype, and hub/INT-209 did the same while its grill ran. Neither agent ran `builder start`, and only a builder record or an answered question started a card.

The owner asked for this in hub/INT-255's thread: "Anything making a prototype should go to in progress. Todo should only be for truly pending items, any builder action moves to in progress."

Considered:
- a new step, such as `item set --status building`, on each kind of work: sessions already mark the owner's message working almost every time, and a builder status needs the owner's go ([only the owner or Auto-build starts a card run](2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md));
- counting any thread line, which [a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md) turned down since it lifts cards moved in with a note but never worked.

Superseded in part by [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): a build's start moves the card to In Progress with a thread line; there is no building status.
