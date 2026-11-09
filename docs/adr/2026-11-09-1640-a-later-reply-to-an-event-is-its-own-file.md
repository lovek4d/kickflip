# A later reply to an event is its own file

A second `reply <id>` used to overwrite `data/replies/<id>.md`, so an ask's thread lost its first answer. A thread is append-only now.

- The first reply stays `<id>.<ext>`; each later one is `<id>~2.md`, `<id>~3.md`, … `~` can't appear in an event id (`domId`), so `<id>.2.md` was ruled out: it could clash with an id ending `.2`.
- `replyFilesOf` (store.mjs) lists an event's reply files oldest first. The board server's `withReply` gives the event `replies` (all, oldest first) and keeps `reply` as the newest, so every `reply?.at` check in domain.mjs sees the latest reply unchanged.
- Any reply resolves an ask and marks its message replied; a later reply changes neither. The push ride-along counts reply files by modified time, so each reply counts once.
- A single legacy `<id>.html` or `.json` still reads as the first reply; `reply` no longer deletes it.
- The starter site appends the same way, in its own code.
- Replies already overwritten are gone.
- #466 may replace the replies store; this stands until then.
