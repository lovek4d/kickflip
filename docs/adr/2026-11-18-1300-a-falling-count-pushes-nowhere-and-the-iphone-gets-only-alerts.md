# A falling count pushes nowhere, and the iPhone gets only alerts

Card #1049 (T-706). The owner was spammed: since the declarative push, Apple shows every push, so each silent count update of [the live row](2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md) arrived on the iPhone as a notification. The owner chose only alerts for the iPhone (t706-iphone), nothing for a count going down on either device ("Just drop this type of notification, same on android and iphone", t706-down) and a badge stale until the next alert or page open (t706-badge). This takes the fallback named under **Still open** in [a push closes the older notifications under its tag](2026-11-15-2230-a-push-closes-the-older-notifications-under-its-tag.md).

## Decision

- **A row that stays open pushes only when something new joins it.** `board/server.mjs` `pushActions` sends nothing when the count falls or only the row's words change. The open notification keeps its old text until the next alert, or until it is withdrawn when nothing waits. Something joining with its alert on alerts; joining with it off sends a silent update, as before.
- **Apple gets no silent push.** `hub/push.mjs` `sendTo` leaves Apple subscriptions out of a silent push, as it does a close push. Android still gets the silent rewrite.
- **Unchanged:** the row's first push, alerts, the queued-alert rewrite, withdraw, quiet hours.
- **The badge** is carried by alerts and set by the page when it opens, so between alerts it can be stale on the iPhone.
