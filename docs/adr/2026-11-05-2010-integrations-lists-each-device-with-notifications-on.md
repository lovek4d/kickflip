# Integrations lists each device with notifications on, each with a Remove

The Notifications row of Integrations keeps its count and lists a line under it for each device that has notifications on: kind, browser and when it was last seen ("Mac · Chrome · seen 2h ago"), as settled in take A of the device-lines prototype. The line of the device you are on adds "this device". Each line has a Remove.

Kind and browser come from the user agent the device subscribed with (`deviceNames` in `hub/push.mjs`). "Seen" is the subscription's `added`, which the device's page rewrites every time its Hub row shows ([hub-kit.js `device`](../../board/public/hub-kit.js)), so it reads as last seen.

The page never holds an endpoint. Each device has an id, a hash of its endpoint, that the hub returns from `/_hub/push/subscribe` and puts on each readiness device. The device keeps its own id in `kickflip.push.id` to find its line, and Remove posts the id to `/_hub/push/forget`, which does what `/_hub/push/unsubscribe` does for an endpoint. A removed device that is still subscribed in its browser comes back on its next visit to the Hub page.

Considered:
- Only the count (parent #57's choice): left no way to tell a stale duplicate from a live device.
