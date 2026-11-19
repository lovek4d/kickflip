# A queue read prunes dead tickets, and install drops the unused test.queue

Found measuring 5 vs 10 land test files at once: `~/.claude/kickflip/test.queue` (no code reads it) and `landtest.queue` (asks whose processes are gone) made a quiet host look busy.

- `queuedAsks` (board/worktree.mjs) removes a ticket whose pid is dead as it reads the queue, so a crashed holder's ticket doesn't stay.
- `removeRetiredState` (bin/install.mjs) deletes state files no code reads any more, `test.queue` the first, as part of `kickflip install` and so `doctor --fix`. New retired files go in its `RETIRED_STATE` list.
