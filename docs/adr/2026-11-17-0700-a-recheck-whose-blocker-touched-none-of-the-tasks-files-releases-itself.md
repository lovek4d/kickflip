# A recheck whose blocker touched none of the task's files releases itself

A ready task whose block ends waits for the orchestrator's re-check of its notes against what landed. When the blocker's
landed diff changed none of the files the task's notes name, nothing the notes rest on moved, so the server ends the wait
itself and posts the thread line "Recheck: <blocker> touched none of this task's files".

- The diff is the builder branch's changed files against its base, taken by finish before the land and passed to
  `setItem` as `landedFiles`. It is a rename's old and new path both.
- The notes name a path as a token with a folder slash or a file extension of letters. A named path matches a changed
  file that is it, that sits inside it as a folder, or that ends with it when it is a bare file name (`SKILL.md`).
- Overlap, notes naming no path, no notes, or a blocker closed without a landed diff (`item set --done`) leave the wait
  to the orchestrator as before, and still raise the `card-unblocked` event. A release raises none.

A token that looks like a path but isn't one (`Node.js`) counts as a named file; if it is the only one, the task
releases on any blocker. The notes then are the only place a task can say what it touches, so a card that must not release
names a real path.

Amended by [a wait a block held is owed from the block's end](2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md): a ready card whose blocker touched a noted file goes back to staging, and one that touched none stays ready.
