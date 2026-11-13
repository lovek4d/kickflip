# Build targets wait on git

Board settings lists a board's build targets from `git ls-tree <main>:.kickflip` (board/build-script.mjs `listBuildTargets`). The call had a 3 s limit, and a git slower than that listed no targets: on a loaded host the Build target picker came up with only the default, and server.test's `/api/build-targets` check flipped (docs/test-determinism-audit.md).

`git ls-tree` reads a local tree and takes no lock, so it finishes; the limit guarded nothing a person would see except that wrong empty list. The call now has no limit, and `listBuildTargets` takes a `run` (execFile's shape), so its parsing and its "none when git can't read the tree" are tested without a repo (board/build-script.test.mjs). A git that hangs, which the limit used to cut off, now holds the Settings request until the hub's proxy gives up on it.
