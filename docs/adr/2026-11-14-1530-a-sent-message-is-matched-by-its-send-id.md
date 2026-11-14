# A sent message is matched by its send id, so it never shows twice

Refines the landed-tap rule of [every reply-box tap shows its line at once and retries in place](2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md), which dropped a landed tap only on a thread load that started after the board answered.

The owner: "Messages briefly double between sending and waiting".

The board writes the event before its POST answers, so a thread load that began just before the answer (a stream change, the 10 s open refresh) can already hold the board's line. It drew that line beside the page's landed copy until the forced reload landed.

- **Thread lines carry their event's `sendId`.** `threadOf` copies `data.sendId` onto the owner's message and request lines.
- **A tap whose sendId is in the loaded thread is not drawn from the page's copy,** whichever load brought it, and a load holding it drops its landed entry. The "started after the answer" rule stays only as the fallback for a line with no sendId (a bare Implement or a Hold, which the board applies without an event).
