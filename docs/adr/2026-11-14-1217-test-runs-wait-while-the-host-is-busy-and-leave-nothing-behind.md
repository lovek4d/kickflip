# Test runs wait while the host is busy, and leave no temp dirs or processes behind

On 11/13 the Mac ran out of memory twice with several test runs going at once. Measured that night: fseventsd held 29 GB and Spotlight 9.8 GB, fed by 52,155 temp dirs our tests had made under `$TMPDIR` and never removed, and 21 test processes (fake builders, test boards, try sites, keep-alive stubs) had outlived their runs, eight of them by 8 days.

## Decision

1. **A test run waits while the host is busy.** `passTests` (board/worktree.mjs), which `board.mjs test`, a land's affected run and the full suite all go through, first waits in `untilHostEases` while `readMachineState` reads busy. That is the same rule as the sidebar's busy dot and the hold on new launches (shared/machine-gate.mjs, docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md), so there is no second threshold. A waiting run says `waiting: the host is busy` once, on its output and its card's line, rechecks every 30 s, and starts when the host eases. Builders and planners already hold on that rule.
2. **Every test's temp dir comes from `tempDir(prefix)`** (shared/temp-dir.mjs), which removes each dir it made as the test process exits. Exit, not each test's `after`, because node runs after hooks in the order they were added: a removal added as the dir is made would run before the servers and processes the test stops later, and a hook-scoped `after` in a `before` or `beforeEach` runs as the hook ends. board/temp-dirs.test.mjs fails any test source (a test or bench file, or a module only test sources import) that makes a dir in the system temp dir any other way.
3. **Test processes exit with their run.** `nodeTests` puts `--import=board/exit-with-run.mjs` in the run's `NODE_OPTIONS` and its own pid in `KICKFLIP_TEST_RUN`. Every node process of the run loads it: the runner, each test file and whatever node process they start with the environment kept, detached or not. It exits the process within a second of the starter being gone, so a run whose starter is killed, cut off or crashes leaves nothing running. suite-run.test.mjs kills a run's starter mid-test and waits, on a FIFO each process holds open, for every one of them to go.

## Considered

- **A free-memory floor of its own** (the card's first proposal, from `vm_stat` or `memory_pressure`). The owner asked for the busy status instead (t290-floor): one rule for what holds work.
- **One host-wide test slot** (T-211). Dropped there by the owner in favour of parallel runs that are bounded; the busy wait bounds them by the host's state, not a count.
- **Scaling `testConcurrency` with free memory.** Not built: the busy wait holds a run before it starts, and half the cores stays the cap.
- **Watching the runner's pid instead of the starter's.** The starter is the process waiting on the result; once it is gone nobody reads the run, so the runner goes too.

## Limits

- A `node --test` started by hand, outside `nodeTests`, doesn't load the watcher; its processes leave as they did before.
- A process that isn't node (Chrome, a shell stub's `sleep`), or a node one started with an environment of its own, doesn't load it either.
- A busy reading the hub's tick left behind keeps runs waiting, as it keeps launches held, until the hub reads the host again.
