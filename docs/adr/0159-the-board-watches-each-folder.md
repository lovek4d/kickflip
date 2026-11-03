# The board watches each folder

This refines how the board server finds writes for its change signal ([0031](0031-the-board-reloads-on-a-change-signal.md)).

**Each folder has its own watch.** `watchTree` in `board/server.mjs` puts a plain `fs.watch` on the tree's root and on every folder under it. A folder's watch reports every write, create, rename and delete of an entry in it, whichever file the name now points at. An event whose entry is a folder not yet watched watches it and the folders under it; an event whose entry is no longer a folder drops the watches at and under it. A root that doesn't exist yet, that goes, or whose watch fails is retried every 2 s, with one signal on the first watch after a retry.

On Linux, Node 22's `fs.watch(dir, { recursive: true })` is built in JavaScript (`internal/fs/recursive_watch`): it watches each file by its own inode and treats a folder's events only as a cue to look for new names. Once a rename replaces a file, as every atomic write here does (a `.tmp` then a rename), its watch stays on the old inode, so later writes to that file send nothing. The v0.3.0 release run failed on this: the stream test's in-place `wave.json` write, after earlier renames over it, sent no change within 30 s. macOS's native recursive watch had no such gap, so the suite passed there.

Considered:
- the recursive watch on macOS and Windows and per-folder watches only on Linux: two ways to watch, one of them untested on the Mac where the boards run;
- polling the tree's modification times: the change signal is there so a write reaches the phone in well under a second.
