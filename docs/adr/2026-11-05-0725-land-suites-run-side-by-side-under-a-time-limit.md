# Land suites run side by side, under a time limit

The host test slot (2026-11-05-0100-one-full-suite-at-a-time-on-the-host.md) made each land's full suite run alone. It never covered a builder's own `node --test` in its worktree, so suites already ran side by side; the slot only queued lands. It then held every land behind one hung run, and a test that took the real slot in process deadlocked lands.

Decision: there is no test slot. A land's suite runs alongside every other suite on the host, like a builder's. The tests that failed under load are made robust instead: they wait on the condition they need, and a timing assertion warns over its budget and fails only at about five times it. No test is about load today, so no test takes a global lock; one that is would take a lock and say why it needs one.

The suite run (`nodeTests` in board/worktree.mjs) gets two limits, folded in from #283:
- each test fails once it runs past 5 minutes (`--test-timeout`), as an ordinary failing test;
- the whole run is cut off at 15 minutes. The run is its own process group, so the cut-off kills the hung file's children with it. The land refuses with "tests hung past 15 minutes in <files>; nothing landed", naming the test files still running, and the land log (`~/.claude/kickflip/logs/land-*.tap`) keeps the partial output and the processes still running at the cut-off, so the next hang leaves its evidence.

The run is asynchronous (`spawn`, not `spawnSync`), since a blocked event loop could fire no cut-off timer.
