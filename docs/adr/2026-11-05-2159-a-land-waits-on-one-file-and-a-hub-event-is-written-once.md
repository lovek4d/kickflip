---
status: accepted
---

# A land waits on one file, and a hub event a board took is written once

#306 took the four rare failures #289 left unproven, each seen only at host load over 250.

## A waiting land watches the one file it waits on

`holdingQueuedLock` and `joiningLand` (board/worktree.mjs) watched the kickflip and queue folders with `fs.watch`. On macOS a folder's watch is FSEvents, which isn't live the moment `fs.watch` returns, and the process's one FSEvents stream restarts whenever any watch in the process opens or closes. A free in that gap was lost, and the waiter woke on its 5 s recheck (the test saw 5010 ms).

Decision (owner, gh306-wake: "Watch the one file it waits on"): a waiter watches the lock file, or the nearest ask ahead of it in the queue, or the land marker it joined, and wakes when that file is removed or replaced (`untilGone`). A file's watch on macOS is a kqueue note, which the event loop registers on its next poll, not when `fs.watch` returns. Measured: a file removed one `setImmediate` after `fs.watch` was missed 50 of 100 times (the immediate can run in the check phase right after the poll that ran the caller); after two, 0 of 1000 under constant watch churn. So `untilGone` checks the file's inode again two immediates after opening the watch, and a file removed before the note was live is caught there. The 5 s recheck stays, for a holder whose process died.

## A hub event is written directly only when nothing listens

This amends 2026-11-05-0820-a-hub-event-a-board-took-is-never-written-twice. The hub's `appendEvent` still wrote the line itself when a board answered with an error. The board writes the line and then builds a whole board for its answer; when that build failed, the answer was a 500 and the hub wrote the line again, so a board got two `github-change` events for one poll.

Decision: the hub appends directly only when the request never reached a board: no port, a refused connection, or a port fetch won't connect to at all (port 1, which tests give a board with no server). Any other failure throws, naming what the board did: no answer in time, an answer that isn't ok (with its status and error), or a dropped connection. The hub posts with `?board=0`, and the board then answers `{id}` alone, building no board, so nothing is left to fail once the line is written. Pages still get the board in the answer.

## Tests

- hub/boards.test.mjs answers `ps` from the `stallingPs` stand-in, in the test and in the hub and board servers it spawns, as hub/sessions and hub/live already do, so a loaded Mac's slow `ps` can't leave a session's liveness unknown and keep an outage. The outage test stalls the stand-in for one poll to show the outage is kept while `ps` gives no answer, then ends it.
- The proxy test's failure says who answered: the status, the body (the hub's own 404 reads "No site at /orch"), and the process listening on the board's port. Its 404 never reproduced, so this closes it until it does.
- A test stand-in's keep-alive is `untilTestEnds()` (shared/test-helpers.mjs): it exits the stand-in once the test process that wrote it is gone. Fake builders a board launches run detached and outlive the server, so the headless tests stop them in their cleanup.
- The Hold/Resume, wave-triage and architecture-review Run tests wait for what they then assert, not for any new board version (`boardSees`): the server marking new cards read moves the version too.
