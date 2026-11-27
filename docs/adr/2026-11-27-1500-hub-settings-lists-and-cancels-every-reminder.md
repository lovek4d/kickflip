# Hub settings lists and cancels every reminder

Notifications gets a **Reminders** row, its summary the count ("5 reminders", nothing when there are none), opening a sheet stacked on the settings modal as the Alerts sheet is.

- **One list for the three kinds.** Each board's cards with a `remind_when` (a "let me know when" reminder, done or needs-you, or a bell, every-stage) group under the board's title, the hub's timed "remind me to" pushes (`reminders.json`) last under **Hub**, each with its time. `hub/reminders.mjs` `listReminders` reads the boards' item files from `listBoards`, so the sheet needs no board server up.
- **Cancel is the lit bell's tap.** A card's reminder is taken off through `board/cards.mjs` `bellItem(…, false)`, which clears whichever `remind_when` it has and writes the owner's Bell off line in the card's thread; a timed one is removed from the hub's file. Both post to `/_hub/settings/reminders`, which answers the settings JSON.
- **Cancelling what is already gone changes nothing.** `cancelReminder` answers false, so a stale sheet's second Cancel is a no-op.

The layout is prototype A: quiet Cancel button at the row's end, the kind in words under the title, no card link.
