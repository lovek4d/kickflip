# The hub and try relays answer only their own Host, and WebSocket Origin

A page on another site can rebind its own DNS name to 127.0.0.1 and reach the hub from the owner's browser, and
`crossSite` can't stop it: it compares Origin with the request's own Host, which the attacker picks.

The owner gate (`board/on-host.mjs` ownerGate), which the hub and every try relay run first, now judges the names
before the client. The Host must be `127.0.0.1`, `localhost` or `[::1]`, or, while the tailnet is on, this Mac's own
tailnet name (`Self.DNSName`); an upgrade's Origin must be one of the same. The port is ignored. Anything else is the
verdict `host` (403). While tailscale hasn't given the name, a tailnet-named request is `unread`, as a login is.

A request with no Host header is let by: no browser sends one. A plain request's Origin stays `crossSite`'s to judge,
now against a Host that is already one of ours. `starter/cross-site.mjs` is unchanged, since a copied site is
reached only through the hub or its own loopback.
