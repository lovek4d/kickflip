# A new task shows at once in the New strip as sending…

Extends [a thread message shows at once, and the browser keeps it until it is sent](2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md) and [every reply-box tap shows its line at once and retries in place](2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md) to the New task box. Supersedes, for the New task box, [every pending control waits in one style](2026-11-03-1915-every-pending-control-waits-in-one-style.md): its Send no longer spins until the server answers.

The New task box used to stay open, its button spinning, until the board recorded the ask, then toast Sent; a failure read "Could not send" under the buttons. The owner (#712) asked for the thread reply's responsiveness here, the task going straight into the New strip.

- **Send closes the box at once.** Implement or Discuss clears the box, closes it and puts the ask in the thread outbox (`site:<route>:outbox`) as kind `ask` with no card key, Implement's `quick: true` in its fields. The asks queue apart from every card's: one at a time, in the order sent.
- **The strip row.** Until the board has it, the ask is a row at the end of the New strip reading `<time> · sending…`, drawn by the thread footer's own state helper (ui-threads.js `pickUp`). The board's New card carries the ask's `sendId` (domain.mjs `it.ask.sendId`), so once the board holds it the board's own row takes its place, reading `<time> · waiting…` and then the strip's blue processing. The time stays first at every step.
- **A failed send** reads `not sent` with Retry and X in the row, each confirmed: Retry sends it again under the same `sendId`; X drops the row and reopens the New task box with its text, before whatever is typed there, and its files (attach.js `restore`). A row the page hasn't sent has no Edit or Delete; the board's row keeps them.
- **A reload resends** the outbox's asks, a failed one included, and the board server's `sendId` check already answers a repeat as recorded.
- **A file still uploading holds the box.** The box's buttons stay free while a file uploads; a tap spins the button until the uploads finish (attach.js `settled`), then sends and closes as above. An upload that fails keeps the box open, its chip saying why, and sends nothing.
- **T-147's sheet height** is moot, as the sheet closes at once, and its repeat case is covered by the `sendId`.

Superseded in part by [a new task's media shows as thumbnails and sends atomically](2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md): a file still uploading no longer holds the box; the task takes it along and is sent once every file is up.
