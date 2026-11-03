---
status: superseded in part by ADR-0131 and ADR-0138
---

# Any work on a card starts it

Superseded in part by [0131](0131-the-cli-and-board-server-do-the-boards-housekeeping.md): the watcher writes the working mark as it prints the message, not `board.mjs working`.

Superseded in part by [0138](0138-a-card-moves-to-in-progress-only-once-building-starts.md): only building starts a card, a build agent's record or a building or fixing status. A grill or prototype agent, a working mark and a recorded prototype leave it in Todo with its Build.

Todo holds only cards nobody has touched since they were filed. A work card is started, and leaves Todo for In Progress, once any of these is true:

- one of its questions is answered or resolved ([0059](0059-an-unstarted-card-waits-on-its-questions-in-todo.md));
- it has a builder record of any kind, `--kind prototype` and `--kind grill` included, running or finished;
- a message in its thread, an item message, an owner answer or another card event, has a `board.mjs working` mark;
- a prototype is recorded for it with `prototype add --card <wave>/<id>`.

`started` in `board/domain.mjs` derives this from records that already exist: builder records, `data/working.json` and `data/prototypes.json`. Nothing writes the wave file. The board server reads both files into every snapshot it builds lanes from, so the idle pull ([0123](0123-an-idle-board-pulls-in-its-top-todo-card.md)) and Build ([0122](0122-a-todo-card-that-nothing-blocks-has-build.md)) skip a card a session is already working on.

- **Asks don't count.** A working mark on the ask a card was made from or folded in is the session sorting the ask, not work on the card, so the new card still starts in Todo.
- **Leaving In Progress.** A started card leaves the usual ways: a running builder, a PR, an owner wait ([0045](0045-the-lane-follows-who-acts-next.md)) or Done. A new question on it keeps its lane with Action needed, as on any started card ([0059](0059-an-unstarted-card-waits-on-its-questions-in-todo.md)). Held is still the only way back to Todo ([0049](0049-a-started-card-never-returns-to-todo.md)).

hub/INT-255 sat in Todo while an agent built its prototype, and hub/INT-209 did the same while its grill ran. Neither agent ran `builder start`, and only a builder record or an answered question started a card.

The owner asked for this in hub/INT-255's thread: "Anything making a prototype should go to in progress. Todo should only be for truly pending items, any builder action moves to in progress."

Considered:
- a new step, such as `item set --status building`, on each kind of work: sessions already mark the owner's message working almost every time, and a builder status needs the owner's go ([0124](0124-only-the-owner-or-auto-build-starts-a-card-run.md));
- counting any thread line, which [0049](0049-a-started-card-never-returns-to-todo.md) turned down since it lifts cards moved in with a note but never worked.
