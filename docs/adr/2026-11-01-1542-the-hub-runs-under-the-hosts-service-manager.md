# The hub runs under the host's service manager

The owner settled `linux-scope` B on hub/INT-207: kickflip runs on any host, a Mac or a Linux machine, with a real Linux path rather than only new words.

- **Words.** Pages, docs, CLI output and doctor say "the host" where they said "this Mac" or "the Mac": "Is the host awake?", "At the host", "Codex isn't installed on the host." "Mac" stays only where something is macOS by nature: the keyboard's ⌘, the login keychain an install script signs with, and the launchd login item.
- **One service layer.** `shared/service.mjs` `hubService()` picks the hub's service by platform. On macOS it is the launchd login item, as before: `~/Library/LaunchAgents/local.claude.kickflip-hub.plist`, started with `launchctl bootout` then `bootstrap`, restarted with `kickstart -k`, read with `print`, and removed with `bootout`. On Linux it is a systemd user unit, `~/.config/systemd/user/kickflip-hub.service` with `Restart=always`: install writes it, then runs `systemctl --user daemon-reload`, `enable` and `restart`; land restarts it with `systemctl --user restart`, doctor reads `is-active`, and uninstall runs `disable --now`. Any other platform has no service: install fails saying so, and doctor marks it yours.
- **Every caller goes through it.** Install and `doctor --fix`, doctor's report, land's hub restart, uninstall and the hub link's restart hint call the layer; none runs launchctl or systemctl itself. On macOS each makes the same calls as before.
- **Lingering.** A user unit stops when the user's last login session ends unless the user lingers. On Linux, doctor reads `loginctl show-user` and, without linger, marks "hub without a login" optional with `sudo loginctl enable-linger "$USER"`.
- **macOS-only parts degrade.** Presence reads macOS `ioreg`, which Linux lacks, so the owner always reads away there and every push reaches every device; doctor notes it. An install script's keychain line appears only on a macOS keychain error. Nothing in kickflip runs caffeinate or osascript.
- **Install hints.** Doctor names Homebrew on macOS (`xcode-select --install`, `brew install gh`, `brew install --cask tailscale`, `brew install --cask codex`) and apt elsewhere (`sudo apt install git`, `sudo apt install gh`), with Tailscale's install script and `npm i -g @openai/codex`, since most distributions package neither.

The layer is tested with stub `launchctl` and `systemctl` on a controlled PATH and the platform injected. Nothing has run on a real Linux host yet.

Considered:
- words only (`linux-scope` A): a Linux owner would have no way to keep the hub running;
- `systemctl --user enable --now` alone on install: it leaves an already-running hub on its old unit, where launchd's bootout and bootstrap replace it; enable then restart does the same on both.
