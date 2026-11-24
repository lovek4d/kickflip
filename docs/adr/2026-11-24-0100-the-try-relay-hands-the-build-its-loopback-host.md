# The try relay hands the build its loopback Host and Origin

A served build runs its own hub, whose host check (board/on-host.mjs hostVerdict) calls any non-loopback name foreign unless its own settings turn the tailnet on, which a temp HOME's never do. The relay forwarded the owner's Host (`<node>.ts.net:<port>`) unchanged, so every Serve build answered 403 "This kickflip answers only its own address".

The relay has already judged the visitor (owner gate, host check, sign-in cookie), so it now sends the build `Host: 127.0.0.1:<port>` and, where the request has one, `Origin: http://127.0.0.1:<port>`, on plain requests and upgrades alike, the address it dials. The relay's own host check and its refusal log are unchanged.

With Host loopback and the forwarded headers stripped, a relayed request would read to the hub behind it as a local process (hub.mjs fromLoopback), which gates /_hub/build, /_hub/pull, /_hub/kill and the hubs send. So the relay also sends `X-Forwarded-Host` with the name the owner typed: fromLoopback refuses any forwarded header, the hub's page host and push subscribe record the real name, and on-host's check, which reads Host only, still passes.
