# A bell on a card pushes at every stage of its task

The owner settled a reminder system in a grill and split it into parts. The first part
([a "let me know when" reminder pushes once](2026-11-26-2200-a-let-me-know-when-reminder-pushes-once.md)) stores one
reminder per task, set by the orchestrator from the owner's words, waiting on one event. This part is the owner's own
way to set one: a bell on the card. Owner: "bell should be all always, just means i want to watch this task closely".
From the prototype, the owner picked the bell icon on the card row, before the "…".

- **A bell is a reminder with no single event.** It is stored with the first part's reminders, as
  `remind_when: every-stage` on the item, one reminder per task. Setting the bell replaces a one-event reminder, and
  a later `board.mjs remind --when` replaces the bell. This keeps one place to list and cancel reminders (the
  Reminders sheet, a later part), and a task with a bell leaves the live row silent, as a task with any reminder does.
- **Set from the card's "…" menu, cancelled from the lit bell.** The menu's Notify me sends `card-bell {key, on:
  true}`. On a card with a reminder, the row shows a lit bell before the "…", blue and filled (info for the owner, by
  the colour rule), and the menu item reads Stop notifying me, checked. Tapping either sends `card-bell {key, on:
  false}` and takes off whichever reminder the task has, the orchestrator's one-event one included. A one-event
  reminder's bell carries its event as a label ("when it's done", "when it needs you"); the owner's bell has none. A
  Done card offers no bell. The tap writes the item file with the owner's Bell on or Bell off line and records no
  event, as a Tag… pick does, and the card draws its bell lit or gone as soon as the tap is in the outbox.
- **The stages are read off the built board at each push check, as the live row is.** `domain.mjs bellStep` compares
  each belled task's lane, its action's kind and its open questions with what `data/bell-stages.json` held at the last
  check. A task newly belled is recorded with no push, so setting the bell pushes nothing. A stage that stands pushes
  nothing, and neither does an action or question ending.
- **One push per task per check, for the change that asks most of the owner.** Done comes first ("<ref> landed" with
  a commit, else "<ref> is done"), then a question that wasn't open (its words), then an action that wasn't there or
  changed kind ("<ref> needs you", with the action's label), then a lane move ("<ref> moved to <lane>"). Several
  changes at one check would replace each other on the phone anyway, since they share the task's `reminder-<key>`
  tag.
- **Every push goes through.** Each is kind `reminder`, `--urgent`, as every reminder is (owner: quiet hours and
  snooze hold no reminder). A stage push writes no thread line: the stage itself already shows on the card.
- **Done is the bell's last push.** The board server clears the bell before it sends the push (`cards.mjs
  endReminder`), with a "Bell's last push sent: it's done." line, so a restart can't push it twice. Done is reached at
  most once, and that push goes out even when Done is the first stage the board sees.
