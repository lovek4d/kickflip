---
status: accepted
---

# The hub has no sharing: only the owner's tailnet identity gets in

Supersedes [a board is shared view only with a Tailscale login](2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md)
and [a shared person is View or Full](2026-11-05-1912-a-shared-person-is-view-or-full.md).

An external security review (T-677) found the sharing paths widened what reaches the boards: a non-owner login passed
the hub's gate onto board reads, the event and upload POSTs of a Full board, and its try relays, and each board server
trusted an `X-Kickflip-Shared` header to name and limit that person. The owner's answer (T-677, 11/17): "close any
non matching tailscale identity for now, drop the sharing mechanism completely. only access locally, or with tailnet on
from matching identity."

- **One verdict.** The hub and every try relay serve a request only when `board/on-host.mjs ownerGate` says `owner`:
  the host, a direct loopback caller, or, while the tailnet is on, a device whose `Tailscale-User-Login` is the host
  node's user. Any other login gets front-door.mjs's `other` refusal (403) on every path and upgrade, the same as
  before #242, whatever a board.json still lists under `share`. There is no `view-only` or `shared` verdict.
- **Gone.** `hub/share.mjs` and its tests; `GET /_hub/share/<route>` and the `share-seen.json` record with its
  minute save (the `share-save` poll); `POST /<route>/api/share` and `settings.mjs saveBoardShare`; the
  `X-Kickflip-Shared` header and the board server's shared-writer check, with `data.shared_by` and the thread name it
  gave a Full person's line; the shared sidebar and stream; Board settings' Sharing section; the shell's
  `.shared-view` and `.shared-full` classes, the View only and Full strips, and the script card's owner-only line.
- **Old board.json `share` lists stay as written.** Nothing reads them, so they are left in place rather than
  migrated away.
- **Copy.** The refusal page's hint and a board page's lost-access landing read "Only its owner’s Tailscale account
  opens it." in place of asking the owner to share.

What this doesn't settle: a local process can still reach a board server's own port, and send
`Tailscale-User-Login` past tailscale serve. Those are T-677's other splits (the owner's sign-in proof, and the Host
and WebSocket Origin allowlist), which build on this slimmer gate.
