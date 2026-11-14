# Every thread status line takes its colour from one tone map

A thread's status lines used to be grey unless the page matched one of five kinds by name (fault, staged, questions
added, readied, created). Each kind of line now carries its tone, and the page draws it.

- A board line's tone is a field of its `HUB_LINES` entry (`hub-lines.mjs`); a tap's is `COMMAND_TONES` (`domain.mjs`).
  `threadOf` puts `tone` on each line and `ui-threads.js` turns it into a `tone-<name>` class, which `style.css`
  colours for the icon, words and link together.
- Tones follow AGENTS.md's colour priority: red faults, orange build work, blue planners and what the owner reads,
  green done, purple merged, grey idle, held and relations. A fault kind takes no tone of its own: its `fault` flag is
  red, which outranks the rest (so `notes-shared`, a fault, stays red).
- A test fails for any kind with no tone, so a new kind cannot ship plain. A kind no longer in the table draws grey.
- A questions-added line is orange while a question in its batch is open, and grey after.
- A tap the page has not sent yet (the outbox) draws grey until the board's own line for it arrives with its tone.
