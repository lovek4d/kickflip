---
status: accepted
---

# A hub card's demo signs itself in through a front port

Once [the owner signs in with a link that sets a device cookie](2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md)
landed, a hub card's demo hub, started by `.kickflip/build` on a try port, showed its sign-in page: the try relay
never passes the owner's cookie to a card's app, which is the card's code.

`.kickflip/build` makes the demo its own sign-in in its throwaway HOME (a link and its redemption, from
`shared/owner-sign-in.mjs`) and announces a front port instead of the demo hub's. The front port passes every request
and upgrade to the demo hub with the demo's own device cookie as the only cookie. The try relay still needs the
owner's real cookie to reach the front port, and drops it there, so the card's code never sees it.

Rejected: running the demo with sign-in off, which needs an off switch in production code; and a token in the try link
the demo exchanges once, which needs the relay to know about one kind of app and gives the cookie to a browser.
