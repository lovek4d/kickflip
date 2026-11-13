# Land suites run side by side, under a time limit

The host test slot (2026-11-05-0100-one-full-suite-at-a-time-on-the-host.md) made each land's full suite run alone. It never covered a builder's own `node --test` in its worktree, so suites already ran side by side; the slot only queued lands. It then held every land behind one hung run, and a test that took the real slot in process deadlocked lands.

Decision: there is no test slot. A land's suite runs alongside every other suite on the host, like a builder's. The tests that failed under load are made robust instead: they wait on the condition they need, and a timing assertion warns over its budget and fails only at about five times it. No test is about load today, so no test takes a global lock; one that is would take a lock and say why it needs one.

The suite run (`nodeTests` in board/worktree.mjs) gets two limits, folded in from #283:
- each test fails once it runs past 5 minutes (`--test-timeout`), as an ordinary failing test. The runner abandons a timed-out test's promise but not its children: a child still running holds the test's file open until the run cut-off. So a test stops what it spawned in `t.after`, which runs on a timeout too, not in a `finally`, which doesn't. `--test-force-exit` would end such a file, but it also ends a file before tests it registers late have run, so a run passed with tests silently missing; it is not used. Whatever a run's tests left in its process group is killed as the run exits;
- the whole run is cut off at 15 minutes. The run is its own process group, so the cut-off kills the hung file's children with it. The land refuses with "tests hung past 15 minutes in <files>; nothing landed", naming the test files still running, and the land log (`~/.claude/kickflip/logs/land-*.tap`) keeps the partial output and the processes still running at the cut-off, so the next hang leaves its evidence.

The run is asynchronous (`spawn`, not `spawnSync`), since a blocked event loop could fire no cut-off timer.

Superseded in part by [lands and builders run only the tests a change affects](2026-11-12-2104-lands-and-builders-run-only-the-tests-a-change-affects.md): a land and a builder run the test files the change affects, not the full suite.
