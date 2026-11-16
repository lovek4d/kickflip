# Every sheet closes by playing its entry backwards

A `.sheet` used to leave with the `.closing` class in the links, new-task, main-log and hold sheets, and vanished at once
in the notes reader and the questions sheet, though `reader-out` and `sheet-out` existed. `BoardUI.closeSheet(sheet,
done)` (ui.js) is now the one close: `.closing` for 180 ms (phone: slides down; desktop reader: slides right; backdrop
fades), then `close()` and `done`; reduced motion closes at once. `BoardUI.cutClose(sheet)` ends a close in progress, so
a reader or questions sheet asked to open mid-exit opens afresh.

Asking the reader for the notes it already shows, or the questions sheet for its open topic, leaves the sheet in place:
no new history entry, no Loading… flash, no replayed slide-in.

A back-button close (popstate) stays instant, as the page has already moved on.
