# Pushes go to the Mac only while the owner is at it

**At the Mac** means the screen is unlocked and a key or the pointer was used in the last 3 minutes, whatever app is in front. `hub/presence.mjs` reads both from `ioreg` with no permission: `CGSSessionScreenIsLocked` from `ioreg -n Root -d1` (absent or `No` while unlocked) and `HIDIdleTime` from `ioreg -c IOHIDSystem`. A reading is reused for 5 seconds. When `ioreg` fails, the owner counts as away, so a push still reaches the phone.

While the owner is at the Mac, an `action` push goes to the desktop subscriptions only, a desktop notification, and the phone gets nothing. `hub/push.mjs` tells a phone from a desktop by the subscription's user agent: iPhone, iPad or Android is a phone, and so is a subscription with no user agent. Once the owner is away, every push goes to every subscription.

- **Prompts, faults and urgent pushes still reach the phone**, at the Mac or not: a permission prompt ([0060](0060-background-sessions-prompts-come-to-the-phone.md)), a board that can't be woken, and `--urgent`.
- **With no desktop subscription, a push goes to every device**, so turning notifications on in a desktop browser is what moves pushes off the phone.
- **Nothing held back catches up.** A push the phone didn't get while the owner was at the Mac is never sent to it later: the owner saw it on the desktop, and the board's unread marks and Needs you keep the rest.
- **A queued push goes by the presence when it is sent**, not when it was queued ([0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)).

The hub page’s Notifications row shows which applies now: "At the Mac", with pushes going to the Mac only, or "Away from the Mac", with pushes going to every device.

Off, snooze, weekends and the overnight hold ([0032](0032-notifications-can-be-off-snoozed-or-off-on-weekends.md)) gate a push first; presence only picks where one that goes is sent.

The owner asked that "notifications on mobile should pause when the desktop app is active" (hub/INT-147) and settled at the Mac as unlocked and used in the last 3 minutes (`at-mac`, take `mac-active`).

Considered:
- a board page open and focused on the desktop: the owner is often at the Mac in another app, and still sees a desktop notification there;
- sending the held pushes to the phone once the owner leaves: they would arrive late and already seen.
