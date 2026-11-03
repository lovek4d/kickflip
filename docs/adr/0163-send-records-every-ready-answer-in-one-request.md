# Send records every ready answer in one request, all or none

Waiting on you's Send posts every ready answer as one `owner-answers {answers: [owner-answer data]}` event to `POST /_claude/events` (`board/public/view-questions.js`). The server records it in one write, or records none of it:

- **All or none.** Before writing anything, every answer must name a question in `data/owner.json`, and the list must hold at least one. Otherwise the POST answers `400 {error}` naming the answers it can't record, and nothing is written (`board/server.mjs` `answersRefused`). `ClaudeSite.send` throws with the server's `error` as `.reason` (`starter/public/claude.js`), and Send reads "Nothing was sent: <reason>" with every draft kept, so the owner can fix and resend.
- **The same side effects as one-by-one answers.** The batch appends one `owner-answer` line per answer to `data/events.jsonl` in a single append, so the watcher wakes once. Note-only answers resolve their questions in one `owner.json` write (`board/store.mjs` `resolveNoteAnswers`). Each card an answer leaves unstarted with nothing stopping it gets one `card-unblocked` line (`domain.mjs` `startedByAnswer`), however many of its answers came in the batch. The single `owner-answer` event goes through the same `recordAnswers`, and the prototype switcher still sends it.
- **One board.** The POST answers `{ids, board}`, the board once, as [0151](0151-every-owner-tap-the-server-can-apply-draws-at-once.md) has every tap do.
- **No optimistic marking.** Send reads "Sending…" until the server answers. Then every draft clears and the questions page reloads, so every answer shows as sent at once.

Send used to await one `owner-answer` POST per question. Each POST answered with the whole board (about 174 KB gzipped), and drafts cleared one at a time, so the button trickled. A failure partway left some answers recorded and some not ("Sent 2 of 3").

The owner (ask, 2026-11-03): "Sending questions should not send them one by one and trickle down the button. It should send them all at once if they're ready." Settled in the grill: one request carries every answer, appended together, all or none, and Send says why when it can't record them. "We shouldn't be optimistically making buttons do things without a server round trip... we can wait for the server, that's fine."

Considered:
- a new route such as `POST /api/answers`: the events POST already handles owner answers, their side effects and the board reply, and `ClaudeSite.send` already reaches it;
- refusing a single `owner-answer` for an unknown question too: the prototype switcher and older pages send it, and until now it always recorded, so it keeps recording;
- clearing each draft as the answers are sent: the owner asked for no marking before the server confirms the write.
