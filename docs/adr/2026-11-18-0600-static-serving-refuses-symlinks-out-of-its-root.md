# Static serving refuses symlinks out of its root

A page's files (hub/files.mjs serveFiles) and a board's public files (board/server.mjs staticFile) were checked for containment on the path's text only, so a symlink inside a served folder could read any file the host could. Both now take the real path of the root and of the target (a directory's index.html included) and serve the file only when the target's real path is inside the root's. A link that stays inside the root still works. The shared check is `realFileUnder` in hub/files.mjs; the file is read from the real path it returns.
