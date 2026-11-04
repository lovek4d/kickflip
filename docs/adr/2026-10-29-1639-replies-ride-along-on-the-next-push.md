---
status: superseded in part by 2026-10-29-1639-pushes-only-when-something-waits-on-the-owner
---

# Replies ride along on the next push; the hub keeps no push log

Superseded in part by [a push goes out only when something waits on the owner, on the hub's schedule](2026-10-29-1639-pushes-only-when-something-waits-on-the-owner.md): no reply pushes, the answer to an ask that became no work and an answer after a thread's push went included; the thread's unread mark carries them, and `thread` takes no `--answer`. The ride-along count, the queued push's body and having no push log below still hold.

A reply to an ask or a thread message never pushes by itself. There are two exceptions: the answer to an ask that became no work ([asks wait in a strip, then become Done items with their own thread](2026-10-29-1639-every-ask-is-a-card.md), round `site-v17`), and an answer in a thread whose push has already gone ([pushes go out by kind, and each arrives on its own](2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md)). A push that goes out for something else adds "· and N replies" to its body. N counts the replies Claude wrote on that site since the site's previous push.

On a board site, sessions push through `board.mjs --site <route> push`. It counts the files in `data/replies/` modified after `last_push` in `data/push-state.json`, then runs `web-ts push` with the same flags. It records `last_push` only when that command succeeds. Before the site's first push through it, N is 0.

A push about one thread carries the latest Claude message, not the first (owner ask, card INT-69). Its tag ties it to the thread: `ask-<eventId>` for an ask, `item-<wave>/<id>` for a work item. While that push waits in the queue ([the hub polls GitHub and sends pushes on one polling interval](2026-10-29-1639-the-hub-polls-github-and-sends-pushes-on-one-interval.md)), each Claude line `board.mjs thread` writes there without `--via`, and each `board.mjs reply` to the ask or to an `item-message` in the thread, rewrites the queued push's body to the message's first line, cut to 160 characters, keeping "· and N replies". Once the push has gone out, a reply or a `thread --answer` line pushes again under the same tag, and any other line never pushes ([pushes go out by kind, and each arrives on its own](2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md), round `site-v23`, v23-thread-after A).

The hub keeps no list of past pushes. A push swiped away from the lock screen is gone, and the site still shows what waits.

Considered options for replies:
- a push per reply during the send-at-once hours;
- folding them into the next push;
- never mentioning them.

For the log, the options were the last 20 pushes on the hub home page, the same list behind a link, or no log.

The owner chose folding and no log (round `site-v8`). This keeps [a push goes out only when something waits on the owner, on the hub's schedule](2026-10-29-1639-pushes-only-when-something-waits-on-the-owner.md): a push still goes out only when something waits on the owner.
