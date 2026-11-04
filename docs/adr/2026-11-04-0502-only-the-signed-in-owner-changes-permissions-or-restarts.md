---
status: accepted
---

# Only the signed-in owner changes permissions or restarts the hub

Permissions' `POST /api/permissions` needed the host's own browser, and the hub's Restart hub (`POST /_hub/restart-hub`) and a board's Restart (`POST /_hub/restart-board`) had no gate beyond the cross-site check: any tailnet device could call them. The owner's answers on #200 (tailscale-signin-notes.md, "Owner answers (11/04)") settled the gate.

- **The signed-in owner is any device logged in as the host's user (owner, gh200-who-is-owner).** `board/on-host.mjs` `fromOwner` is true when the request's client address is one of the machine's own (the host, as in `fromHost`), or when tailscale serve's `Tailscale-User-Login` equals the user of the host's tailnet node (`tailscale status --json` Self, read by the same `tailnetNode` as `fromHost`). Every one of the owner's devices carries that user, so the login can't tell them apart, and doesn't need to. A shared-in node carries its sharer's login and a tagged node gets no login header, so both are refused.
- **A direct loopback caller is the owner (owner, gh200-loopback).** A request with no `X-Forwarded-For` reached the hub on 127.0.0.1 without tailscale serve, so it is a process on the host. The hub listens on 127.0.0.1 alone, which is also why the login header can be trusted: serve replaces it, and only a local process can send it past serve.
- **Both restarts and the permission switches use the gate (owner, gh200-restart-scope).** `/_hub/restart-board` and `/_hub/restart-hub` answer 403 `{error}` for anyone else, which the hub page shows as its error flash. `/api/permissions` answers `owner` in place of `onHost`, and the page disables its switches with "Only the signed-in owner can change these." when it is false.
- **`onHost` stays for what needs the host's own machine.** Open in VS Code opens a local path, so `/api/board`'s `onHost` still comes from `fromHost`.

Gating the whole hub on the same identity is #210.
