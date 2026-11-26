# A "let me know when" reminder pushes once

The board's pushes were all default: one live row per board for what waits on the owner, faults, prompts, and opt-in
alerts that sound the row. The owner wanted fewer default pushes and a way to ask for the one they care about: "let me
know when this is done". The owner settled the design in a grill and split it into parts; this is the part set by
words to the orchestrator. The bell on a card, timed "remind me to" pushes and a Reminders sheet come in their own
parts and build on this store.

- **One reminder per task, set by the orchestrator** from the owner's words: `board.mjs remind <key> --when
  done|needs-you`, stored on the item as `remind_when`, with a Reminder line in its thread. A second `remind`
  replaces the first; `--cancel` takes it off. A task already done takes none.
- **Two events.** `done` holds when the task's lane is Done (landed, merged, or closed). `needs-you` holds when the
  task has an Action needed or a question of its own in the board's live row (`domain.mjs ownerActions`), read off
  the built board at each push check (`server.mjs pushReminders`), as the live row is. "Lands" and "merges" are
  `done`.
- **It pushes once, through every hold.** The board server clears the reminder from the item first (`cards.mjs
  endReminder`), so a restart can't push it twice, then sends kind `reminder`, `--urgent`, so quiet hours, a snooze
  and the weekend don't hold it (owner: every reminder goes through), tagged `reminder-<key>`. A `needs-you` push
  reads as the task's action does and lands where the owner answers; a `done` push reads "<ref> is done" and opens
  the task. A Reminder sent line goes in the thread.
- **A needs-you reminder on a task that closes ends with no push**, with a Reminder dropped line: the owner asked to
  be told about a wait, and a closed task has none.
- **A reminder sounds in place of the live row** (owner: replace, not beside). While a task has one, its action
  joining the board's live notification never alerts it: a row it opens goes out silently, and it is no alert
  switch's join. Faults, prompts and the other tasks' actions sound as before.
- **A needs-you reminder set while the task already needs the owner fires at the next check**: the condition is read,
  not an edge.
