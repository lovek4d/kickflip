---
status: accepted
---

# Every push goes to every device

Supersedes [pushes go to the Mac only while the owner is at it](2026-10-30-1704-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md). A push, now or from the queue, goes to every subscribed device whatever the owner's presence reads; `hub/push.mjs` no longer tells a phone from a desktop.

The owner asked to "drop the away from Mac push system".

Kept, since neither is routing: the owner's presence still sets the hub's check cadence ([the hub checks every minute while you’re here and every 5 when away](2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md)) and the moon on the page, through `ownerTracker` and `readPresence` in `hub/presence.mjs`.

Removed with the routing: the 5-second reading cache (`presenceReader`, which only spared a flush of several pushes repeated `ioreg` reads), `pushRoute`, and the "At the host" / "Away from the host" row in the Hub page's Notifications.
