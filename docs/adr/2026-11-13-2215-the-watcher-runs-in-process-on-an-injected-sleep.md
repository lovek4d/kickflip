# The watcher runs in process on an injected sleep

`bin/wait-events.mjs` exports `watch({ route, session, sleep, sessionGone, log, pid, links })`. Its 2 s poll and 2 s
batching window run on `sleep(ms)`, the death of the launching session is `sessionGone()`, and what it prints goes
through `log`. The command line only builds the real `sleep`, the `ps`-backed `sessionGone` and `process.pid`, and
exits with the code `watch` returns.

wait-events.test drives `watch` in the test process on a clock the test turns, so a test that needs "the watcher has
polled and woke nothing" takes a step instead of waiting 2.5 s. The tests of the real process chain (a session that
dies, a stalled `ps`, a second watcher stopping the first) still spawn the watcher.

Each poll that finds nothing to wake for adds a `checks` count to watcher.json, which those spawned tests await
instead of a timer.

The watcher tests in board/server.test.mjs and hub/close-board.test.mjs spawn the real script against a real board
server and stay as they are.
