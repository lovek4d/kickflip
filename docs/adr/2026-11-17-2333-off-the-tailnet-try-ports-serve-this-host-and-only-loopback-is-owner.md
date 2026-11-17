# Off the tailnet, try ports serve this host and only loopback is owner

Card #1011 (T-672), split 2 of T-665. Owner (11/17): "Try/Serve with the tailnet off: serve on the host only." It
builds on [the tailnet is opt-in with kickflip tailnet](2026-11-18-0300-the-tailnet-is-opt-in-with-kickflip-tailnet.md),
which left the try ports and the owner gate to this card.

Until now each served card, Main and the base prototype serve had a relay on a random loopback port, and its try port
(8500–8599) existed only as `tailscale serve --https=<port>` mapped to that relay. Visit links and the served prototype
frame were `https://<page's host>:<port>/`. With the tailnet off nothing could open them. The owner gate called every
host address owner, and asked tailscale about any request with a `Tailscale-User-Login`.

## Decision

- **The relay listens on its try port, `127.0.0.1:<port>`, on or off.** The host's browser opens it there. While the
  tailnet is on, `tailscale serve --https=<port>` maps the same port on the tailnet to it, as before; tailscale serve
  holds the tailnet address, not loopback, so the two don't meet (checked on this Mac with 8500 mapped). One port per
  run, on or off, so turning the tailnet on while a serve is up needs no new serve: the next tick's re-serve check maps
  the port to the relay already listening, and a Kill after that unmaps it.
- **Off runs no tailscale in try.mjs.** No `serve --bg`, no startup sweep of unclaimed ports, no tick re-serve check,
  no `off` at a Kill. `kickflip tailnet off` already unmapped the try ports.
- **Main's handover moves the listener.** Main's old run keeps serving while its successor starts on the same try port.
  Once the successor answers, its relay closes the old relay's listener and listens itself; the old run's open
  connections finish until it's retired a moment later. This is the moment `tailscale serve` used to switch the mapping.
- **A held port is waited for, 15 s at most.** A restart starts the new hub before the old one has closed its relays, so
  a relay finding its port in use tries again every 250 ms (`poll: try-relay-wait`), then fails the serve with "another
  program listens on 127.0.0.1:<port>".
- **Links follow the page.** A page served over http, which is the host's own page at `http://127.0.0.1:<hub port>/`
  (or `localhost`), opens and frames the try port at `http://127.0.0.1:<port>/`; an https page (the tailnet) at
  `https://<page's host>:<port>/`, as before. The page needs no word on the setting: its scheme says which.
- **Off, the owner is a loopback client alone.** `ownerGate` and `fromHost` (board/on-host.mjs) read `tailnetOn` on each
  request. Off, the client is the forwarded address when there is one, else the socket's, and only loopback is owner or
  the host; `Tailscale-User-Login` isn't read and tailscale isn't asked (`gate.node()` is null). A `tailscale serve`
  mapping left in place on an install that is off by default still forwards each tailnet device with its own address,
  so none of them, the owner's phone included, gets in until `kickflip tailnet on`. On, the gate is unchanged.

Sharing (Settings › Sharing, the share link) is left as it is: T-687 removes it.

## Consequences

- With the tailnet on, the host's own browser at `http://127.0.0.1:<hub port>/` now opens Visit too, where its link
  was `https://127.0.0.1:<port>/` and answered nothing.
- A try port is now a loopback port as well: another program already on 8500–8599 fails that serve, with the reason.
- Turning the tailnet off while a serve is up leaves it served on this host, as it was.
- T-677's owner sign-in builds on the on branch of the gate; the off branch is loopback alone.
