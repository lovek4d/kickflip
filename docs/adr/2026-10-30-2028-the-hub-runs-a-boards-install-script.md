---
status: superseded in part by 2026-11-01-1542-the-hub-runs-under-the-hosts-service-manager and 2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main
---

# The hub runs a board's install script

Superseded in part by [a board's build script serves or builds each card and main](2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md): the fixed repo build script replaces the owner-set path, and try state, serving, main builds and failure-only thread reports replace install builder records.

Superseded in part by [the hub runs under the host's service manager](2026-11-01-1542-the-hub-runs-under-the-hosts-service-manager.md): the hub runs under the host's service manager, a LaunchAgent on macOS or a systemd user unit on Linux; signing with the login keychain still needs macOS.

Claude sessions the hub resumes run in macOS launchd's Background session. There, codesign cannot reach the login keychain unlocked in the GUI session and can fail with errSecInternalComponent even after the owner unlocks it. The hub's LaunchAgent runs in the GUI session, so the hub runs device install builds on the board's behalf.

The owner sets one absolute `install_script` path in each board's `board.json`, only through that board's Settings modal. Saving it and every run require an existing regular file owned by the current user and writable by neither group nor others. An empty setting disables install builds; changing it writes a hub log line without a thread message. There is no CLI to set it.

`board.mjs --site <route> install <key>` posts `{route, key}` to the hub's loopback-only `POST /_hub/install`. The hub finds the board through `hub/boards.mjs`, refuses an unset or invalid script and a second running install on the same card, then spawns `<script> <key> <worktree>` without a shell, in the board's site directory. The worktree comes from the card's newest builder record carrying one, else the wave item's `worktree` resolved against its repo checkout. The hub matches the wave's `repo` to a GitHub origin in the manifest's recorded session folders or the board's site directory, using the checkout root even when the session folder is nested. With no known checkout the item fallback is empty. The argument is the real path of an existing directory under that repo's `.claude/worktrees/` or `~/.claude/web-ts/worktrees/`; traversal and symlink escapes, missing paths and other locations give an empty string. The hub only runs the owner-set script with fixed arguments, never a caller-named command.

The CLI prints `started` and exits. The hub opens the existing builder record with kind and agent `install`, sends stdout and stderr to `data/installs/<id>.log` (replaced each run), closes the builder at exit, and appends one thread message with the result and the log's last five lines. A keychain failure also says the login keychain must be unlocked on the Mac. The script still publishes the install link and its head sha through `board.mjs item set`.

Builds can now sign when requested by a Background session, and the owner can follow them on the card without keeping a session waiting. The login keychain still needs unlocking once after login. Each board owns and maintains its script; the hub supplies execution and records rather than platform-specific build steps.
