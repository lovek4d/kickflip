# The shell keeps every sidebar board's saved copy fresh

A board's saved copy (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md) was written only by that board's own page, so a board the owner hadn't opened lately painted old, and a copy saved under an earlier build read as none after a hub update. The shell already holds the hub's one stream, which signals every board's changes, so it keeps the copies (#817, part B of #705).

- **When.** On app open for each sidebar board, and on that board's `change` event from `/_hub/stream`, at most once a minute per board (`shell.js keepFresh`). A change inside the minute is dropped: the next change, or opening the board, catches up by `?since` anyway.
- **What.** `BoardUI.syncCopy` (`ui-snapshot.js`) asks `api/board?since=<copy's number>` and applies the patch with its threads and notes to the copy, as the board page does. With no copy, or one another build saved, it loads the whole board, every card's thread and `api/notes?all=1`. So a hub update refetches the old-build copies in the background the next time the shell opens.
- **Not the board on screen.** A board the shell shows, or keeps mounted beside Waiting on you on a phone, saves its own copy. A sync that finds the copy replaced while it fetched, which only that page does, saves nothing.
- **`copyVersion`.** After a save the shell writes the board's `site:<route>:copyVersion`, since `app.html`'s boot asks `?since` that number and the page applies the patch to the copy it paints.
- A failed sync leaves the copy as it was.
