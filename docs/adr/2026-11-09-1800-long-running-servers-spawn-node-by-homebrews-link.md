# Long-running servers spawn node by Homebrew's link

`brew upgrade` removes the versioned Cellar folder that `process.execPath` names, so a hub or board server started before the upgrade failed its pushes with `spawn .../Cellar/node/<version>/bin/node ENOENT`.

The hub's update spawn (hub/hub.mjs) and the board's push (board/store.mjs), merge (board/server.mjs), test run and restart (board/worktree.mjs) now spawn `nodeBin()` from bin/install.mjs.

`nodeBin()` names `/opt/homebrew/bin/node` only when the running node sits under `/opt/homebrew/Cellar/` and the link exists. An nvm or system node keeps its own `process.execPath`. Test fixtures stay on `process.execPath`; the `KICKFLIP_PUSH_CMD`, `KICKFLIP_MERGE_CMD` and `KICKFLIP_RESTART_CMD` overrides still win.
