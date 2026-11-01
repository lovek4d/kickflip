---
status: superseded in part by ADR-0093
---

# Doctor checks and fixes a hub

Superseded in part by [0093](0093-the-hub-runs-under-the-hosts-service-manager.md): the login item is the hub's service, a systemd user unit on Linux with a linger note, and install hints name apt off macOS.

The owner picked option A of `doctor-shape` on hub/INT-196: one check and one fix path, under two names.

- `kickflip doctor` replaces `status`. It only reads, and reports the prereqs (git, node on Claude's PATH, gh signed in, Tailscale signed in, a Codex login), what install sets up (the skill and hooks-plugin links, the status line, the login item), then the hub, Tailscale `/` and each site.
- Each item is ok; fixable, which `doctor --fix` sets up; yours, with the command only the person can run, such as `gh auth login`; optional, the Codex login; or note, a down site the running hub restarts on its own. Doctor exits 1 only for fixable or yours, so the skill runs `doctor`, asks once, then runs `doctor --fix`.
- `doctor --fix` runs install's steps (`runInstall()` in `bin/install.mjs`) and reports again. `install` stays as the first-run name for `doctor --fix`.
- Another tool's status line stays the person's, as in [0080](0080-kickflip-installs-its-own-status-line-and-hooks.md): doctor marks it yours and prints how to move it aside.
