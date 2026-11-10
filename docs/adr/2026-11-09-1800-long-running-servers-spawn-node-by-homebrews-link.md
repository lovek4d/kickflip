# Long-running servers spawn node by Homebrew's link

`brew upgrade` removes the versioned Cellar folder that `process.execPath` names, so a hub or board server started before the upgrade failed its pushes with `spawn .../Cellar/node/<version>/bin/node ENOENT`.

The hub's update spawn (hub/hub.mjs) and the board's push (board/store.mjs), merge (board/server.mjs), test run and restart (board/worktree.mjs) now spawn `nodeBin()` from bin/install.mjs.

`nodeBin()` names `/opt/homebrew/bin/node` only when the running node sits under `/opt/homebrew/Cellar/` and the link exists. An nvm or system node keeps its own `process.execPath`. Test fixtures stay on `process.execPath`; the `KICKFLIP_PUSH_CMD`, `KICKFLIP_MERGE_CMD` and `KICKFLIP_RESTART_CMD` overrides still win.

Commands stored before that change still name the Cellar node. As the hub starts, before any site does, `migrateCellarNode` (hub/boards.mjs) rewrites a manifest site's `cmd[0]` matching `/opt/homebrew/Cellar/node/<version>/bin/node` through `nodeBin()`, and rewrites the hub's login item file (launchd plist or systemd unit) the same way. `node@NN` kegs are left alone, since the link may not be that version. Every `kickflip update` ends in a hub restart, so the start migration covers it. Settings hooks store nothing to rewrite: `BG_SETTINGS` is built from `nodeBin()` each time. The login item is rewritten as a file only, not reloaded; a host whose item already names a removed node can't start the hub, and `kickflip init` rescues it.
