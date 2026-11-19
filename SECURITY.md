# Security

## Reporting a vulnerability

Report a vulnerability through GitHub's private vulnerability reporting: the repository's Security tab, "Report a vulnerability". Please don't open a public issue for it.

Private vulnerability reporting is a repository setting, and the owner turns it on in the repository's settings (Settings, Advanced Security, Private vulnerability reporting).

## Threat model

kickflip is a single-owner tool. It runs on the owner's Mac and serves the owner's phone over a tailnet.

**Who is trusted**

- The owner, signed in on a device, is trusted with everything: approving and running a board's scripts, merging, and settings. A device signs in by typing an 8-digit PIN that `kickflip link`, or Hub settings › Devices' Show PIN on a signed-in device, shows; a PIN lasts 60 seconds and signs in one device, which then carries an HttpOnly cookie. The hub, its try ports and every board server check that cookie on every page, read and tap. Three wrong PINs from one device (its tailnet node, else its address) void every live PIN and block it until `kickflip unblock` or Devices' Unblock. `kickflip unlink` signs one device out, and `kickflip sign-out` every device.
- The agents (Claude Code and Codex sessions the boards launch) run as the owner's OS user. They are trusted to build, not to approve. They write board files through the CLI and need no owner rights over HTTP: without the cookie, a process on this Mac gets only the agent paths (builds, permission prompts, status, and the events agents post), never a script's Run, an answer, a card tap or a setting.
- The owner's other hubs: another machine signed in to the tailnet as the owner's own Tailscale login. It can file a one-line question on a board here, answer one a board here asked it, and list the boards' routes and titles, nothing more; it reads no cards, threads, notes or code. This hub sends to another hub only for an agent on this host, over loopback.

**Who is not trusted**

- Any other machine or tailnet identity. Over the tailnet the hub serves only the owner's own Tailscale login and refuses every other; there is no sharing mechanism.
- Web pages in the owner's browser. The previews a board shows (prototypes and visuals) run in a sandboxed frame with an opaque origin, isolated from the app's origin. A site's own public/ files never replace the board's: the board's scripts and styles are looked up first, and the site's files serve only the paths the board doesn't use.
- A file inside a served directory that points outside it (symlinks are refused).

**What stays outside the model**

A process running as the same OS user can read anything the hub keeps on disk, and can run `kickflip link` and use its PIN. The sign-in stops a web page, or a one-line request from a builder, acting as the owner; it doesn't stop a process set on doing so. An agent is trusted not to approve, but nothing stops a determined one. If you run an agent you don't trust, run it as another user.

**The supply chain**

CI runs the tests on every push to main and every pull request. Every GitHub Action the workflows use is pinned to a full commit SHA, so a moved tag can't change what runs; update a pin by looking up the new release's commit.
