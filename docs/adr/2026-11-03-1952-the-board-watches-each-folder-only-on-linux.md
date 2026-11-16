---
status: superseded by 2026-11-16-0328-the-board-server-drops-its-file-watch
---

# The board watches each folder only on Linux, and never lock folders or build output

This supersedes in part [the board watches each folder](2026-11-03-1517-the-board-watches-each-folder.md): the per-folder watch stays, on Linux only.

**macOS and Windows have one recursive watch.** `watchTree` in `board/server.mjs` puts one `fs.watch(root, { recursive: true })` on each tree. On macOS, libuv merges every `fs.watch` into one FSEventStream and rebuilds it whenever a watch is added or closed. The iOS board watches all of `~/.claude/waves`, about 5,500 folders, most of them Xcode DerivedData under `dd/`, while `.locks/` folders keep appearing and going. Each one opened or closed a watch, and closing it from inside the watch callback blocked the main thread in `uv__fsevents_close`, so the server answered no request and hung again within seconds of a restart. FSEvents follows a file through a rename, so the recursive watch keeps the change signal that the per-folder watch was built for.

**Linux keeps a watch on each folder.** Node 22's recursive watch there loses a file once a rename replaces it (see the superseded record), so each folder still has its own watch, but a folder whose name starts with `.` or is `node_modules`, `dd` or `DerivedData` is never watched, nor anything under it.

**Both send no change for those paths.** An event whose path, relative to the tree, has a segment starting with `.` or named `node_modules`, `dd` or `DerivedData`, or that names a `.tmp` file, sends no change. No board file lives under them.

The churn test in `board/server.test.mjs` builds a tree of about 4,500 folders, creates and removes `.locks/` folders throughout, and checks that a request answers within its budget, that the locks send no change and that a write in a normal folder sends one. It runs on the Mac, and in a `node:22` container for the Linux path.

Considered:
- per-folder watches on macOS that skip dot-folders and build output: fewer watches, but any folder that comes and goes still rebuilds the FSEventStream on the main thread.
