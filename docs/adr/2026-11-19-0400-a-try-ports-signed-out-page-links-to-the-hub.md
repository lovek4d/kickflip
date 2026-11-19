# A try port's signed-out page links to the hub

A try port's relay has no `/_hub/sign-in` route, so the PIN form the hub draws posted to a path the port lacks. The relay
now answers a page load with no device cookie with "Sign in on the hub first." and a link to the hub's address (tailnet
name, else loopback), in place of the form. The cookie the hub sets is host-scoped, and cookies ignore the port, so
the relay's own cookie check passes on reload with no redirect through the hub. The relay still never passes the cookie
to the card's app (T-715).
