# Security

## Reporting a vulnerability

Report a vulnerability through GitHub's private vulnerability reporting: the repository's Security tab, "Report a vulnerability". Please don't open a public issue for it.

Private vulnerability reporting is a repository setting, and the owner turns it on in the repository's settings (Settings, Advanced Security, Private vulnerability reporting).

## Threat model

kickflip is a single-owner tool. It runs on the owner's Mac and serves the owner's phone over a tailnet.

**Who is trusted**

- The owner, signed in on a device, is trusted with everything: approving and running a board's scripts, merging, and settings.
- The agents (Claude Code and Codex sessions the boards launch) run as the owner's OS user. They are trusted to build, not to approve. They write board files through the CLI and need no owner rights over HTTP.

**Who is not trusted**

- Any other tailnet identity the owner hasn't shared a board with. Over the tailnet the hub serves the owner's own Tailscale login and refuses any other, except a login the owner shared a board with, which gets that board alone, view-only or full.
- Web pages in the owner's browser. The previews a board shows (prototypes and visuals) run in a sandboxed frame with an opaque origin, isolated from the app's origin.

**What stays outside the model**

A process running as the same OS user can read anything the hub keeps on disk, and a request from this Mac's loopback is served as the owner. An agent is trusted not to approve, but nothing stops it doing so. If you run an agent you don't trust, run it as another user.

**The supply chain**

CI runs the tests on every push to main and every pull request. Every GitHub Action the workflows use is pinned to a full commit SHA, so a moved tag can't change what runs; update a pin by looking up the new release's commit.
