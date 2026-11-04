# The hub tells the host's browser by its forwarded address, then its tailnet node

`board/on-host.mjs` `fromHost` decides whether a board request comes from a browser on the hub's own machine. Board Permissions (#130) and Open in VS Code (#112) both read it. #112 built it on `X-Forwarded-For` without checking it live. #162 checked it live and added a fallback for a host whose tailnet address isn't on any of its network interfaces. This card covers detection only. Sign-in through Tailscale identity is #200.

## What tailscale serve sends (checked live, 11/04)

A throwaway echo server was joined as a plain page (`kickflip join --name gh162-echo --port 4799`), curled, then removed with `kickflip leave`. The host was Tailscale 1.102.4 on macOS, with `https://loves-macbook-pro.myth-alkaline.ts.net` proxying `/` to `http://127.0.0.1:4500`.

- **From the host through the tailnet URL**, the site saw the request arrive from `127.0.0.1` with:
  - `X-Forwarded-For: 100.81.98.101`, which is the host node's own IPv4 address and is on its `utun` interface;
  - `Tailscale-User-Login: lovek4d@github`, `Tailscale-User-Name: Love`, `Tailscale-User-Profile-Pic`, and `Tailscale-Headers-Info`;
  - `X-Forwarded-Host`, `X-Forwarded-Proto: https`, and the hub's `X-Forwarded-Prefix`.

  `curl -6` showed the same IPv4 address.
- **Straight to the hub on localhost** (`http://127.0.0.1:4500`), the request had no `X-Forwarded-For` and no `Tailscale-*` headers. The hub adds only `X-Forwarded-Prefix`, `X-Forwarded-Host` and `X-Forwarded-Proto`. The hub listens on `127.0.0.1` only.
- **Headers a client tries to spoof:** for `X-Forwarded-For: 1.2.3.4` and `Tailscale-User-Login: evil@x`, serve replaced each value with its own; it doesn't append. Serve has no node or device header, and a client's `Tailscale-Node-Name: fake` reached the site unchanged.
- **Live board:** `/hub-orchestrator/api/board`, fetched from the host through the tailnet URL, answered `onHost: true`.

The X-Forwarded-For check works live. The first ADR said serve puts the client's address *last* in the header ([2026-11-03-1544](2026-11-03-1544-a-building-card-opens-its-worktree-in-vs-code-on-the-host.md)). In fact serve sets the whole header to that one address. Reading the last entry is still right.

## Decision

- **First, the interface check, unchanged.** A request is from the host when its forwarded address, or the socket's address when nothing was forwarded, is one of the machine's interface addresses (`os.networkInterfaces`).
- **Then, the host's tailnet node** (owner, gh162-signal: xff-then-login). This covers a host whose tailnet address isn't on an interface, such as tailscaled in userspace networking. When the interface check fails, the request was forwarded, and it carries `Tailscale-User-Login`, the hub runs `tailscale status --json`. The request is the host's when the login is `Self`'s user and the forwarded address is one of `Self.TailscaleIPs`, the host node's own addresses. `tailscale status` runs only on this path, asynchronously, and isn't cached. When it fails, the request isn't the host's.
- **No node-name header is read.** Serve sends none, and serve passes a client's `Tailscale-Node-Name` through. The node is identified by its address, which serve sets itself.
- `fromHost` is now async. `board/server.mjs` awaits it for `onHost` and for the `POST /api/permissions` 403.

Considered:
- the login alone: the owner's phone and Mac sign in as the same user (`lovek4d@github`), so the login can't tell them apart;
- `tailscale whois <forwarded address>` for the node name: it returns the same node that `Self.TailscaleIPs` names, at the cost of an extra call for each request.
