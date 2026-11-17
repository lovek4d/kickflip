# Test determinism audit

Card #652. The owner's rules: "load should simply not impact tests, they should be deterministic", and "we should not have any timer based tests in main suite, that should be a perf bench specific action".

This report lists each test whose result or run time depends on the machine, with the seam that removes the dependence, and groups those seams into fix tasks. It is a snapshot of main at af1979bd; line numbers are from that commit. The guard `board/timer-free.test.mjs` holds the main suite to what is listed here: a test file may hold no more timer waits than its count there, and each fix task lowers its files' counts (docs/adr/2026-11-13-2130-the-main-suite-holds-no-new-timer-waits.md).

## How to read the tables

**Kinds** (what the test waits on):

- **TIMING-CHECK**: asserts on elapsed time, or on the real clock within a tolerance. Each one goes to the perf bench, is deleted, or is rewritten to assert behaviour (see [Timing checks](#timing-checks-and-where-each-goes)).
- **NEGATIVE-SLEEP**: sleeps, then asserts something did not happen. Under load it passes without testing anything, because the work it guards against has not run yet; and a pass still running from before the sleep can land after it and fail it.
- **WAIT-ON-TIME**: polls or sleeps until a state appears (`until`, `untilHeard`, `boardSees`, hand-rolled deadline loops, a code-under-test interval the test waits out). Fails at its ceiling.
- **PROCESS**: awaits a spawned process's readiness or exit (board server, hub, fake `claude`, wait-events, CLI with a time limit).
- **PORT**: picks a port with `freePorts()` and binds it later from another process, so a parallel file can take it in between.
- **CHROME**: headless Chrome with an exec timeout.
- **MACHINE**: reads the real machine: load, memory pressure, `ps`, the process table.
- **CLOCK**: builds data from the real clock, and the code under test reads the clock again; a stall between the two changes the words.

**Seams** (what replaces the wait):

- **S1, injected clock or timers**: a `now` option, or `t.mock.timers`, ticked by the test. `t.mock.timers.enable({apis: ['setTimeout']})` does not mock `node:timers/promises` on Node 26, so a test can mock the code's timers while its own awaits stay real.
- **S2, call the change handler**: the test calls the server's `changed()` / `heard(root, name)` after a write, instead of waiting for macOS fs.watch to report it.
- **S3, in-process server with `settled()`**: the server is imported, listens on port 0 or takes requests by `server.emit('request')`, and resolves `settled()` once every pass a change started has finished. Replaces polling `/api/board`.
- **S3t, try manager `settled()`**: the same for `hub/try.mjs`'s manager: a promise that resolves when a run's state changes (`update()`), awaited instead of polling try.json.
- **S4, injected runner**: the module takes the function that spawns, fetches, runs git or ps, or launches an agent; the test passes one that records the call and answers.
- **S5, a stand-in that signals**: the stand-in process prints a line or writes a file at the state the test needs, and lives until the test releases it (`untilTestEnds()`), not for a fixed time.
- **S6, await the event, no ceiling**: await `'exit'`, `'close'` or a stdout line with no timer; the run's per-file timeout is the only ceiling.
- **S7, perf bench**: the check measures speed; it moves out of the main suite.
- **S8, delete**: the check measures nothing a person would act on.

## What the audit found

**Two scripts are behind most of it.** `board/server.mjs` and `hub/hub.mjs` are top-level scripts: no exports, a real `server.listen(port)`, a real fs.watch on their data, real intervals (the server's 100–500 ms change debounce and 60 s minute pass, board/server.mjs:993 and :2302; the hub's 2 s reconcile and 15 s tick, hub/hub.mjs:426 and :596). Every test of either one spawns it as a child, picks its port with `freePorts`, and then polls for the result of a write it can't see land. That is server.test, server-stale, headless, server-builds and the hub files. No in-process fix is possible until each script exports a start function. Some tests already import server.mjs by hand in a child with `listen` and `Date` mocked (board/server.test.mjs:1811 and :1849, board/repo.test.mjs:12), which shows the shape.

**Code under test has its own time limits, and load trips them.** These change a test's result, not only its time:

| limit | where | tests it flips |
|---|---|---|
| hub reads the real load every 15 s and holds work at load ≥ 4× cores | hub/hub.mjs:600 `checkMachine()` with no reading (shared/machine-gate.mjs:22) | every test that spawns the hub; try.test 1218 answers 409 |
| `kickflip` gives up on the hub after 1.5 s | bin/kickflip.mjs:300-304 | join.test throughout; boards.test 679, 693, 870 |
| git 3 s in the try manager | hub/try.mjs:28 | every try.test start and tick |
| `git ls-tree` 3 s | board/build-script.mjs:31 | server.test 1600 |
| `ps` 3 s | hub/live.mjs:44-46 | live.test, orchestrator-stops, sessions, wait-events, prompts 451 |
| lock wait 10 s | hub/locks.mjs:15-24 | merge3, board-items 295, lanes 141 |
| session id wait 15 s | board/agents.mjs:38-51 `SESSION_WAIT_MS` | agents.test 26, 46 |
| people lookup 12 s | board/server.mjs:760 `withinWait` | server.test 1648, 1684, 1689 |
| permission hook POST 5 s, retry 2 s | hub/permission-hook.mjs:14, :41 | boards.test 804, prompts 422 |
| needs read 4 s, device push 15 s | hub/push.mjs:124, :145 | push.test 72 |
| status line git 500 ms | bin/statusline.mjs:13 | statusline.test 24 (retried 5 times) |
| Working fetch 3 s | hooks-plugin/hooks/watcher-stop.mjs:14 | watcher-stop.test 45 |

Each is a fix in the code's seam (S4, the runner passed in) or, where the limit guards nothing a person would see, its removal. A fix task that removes a limit from shipped code changes behaviour on a slow host too, so it says so in its own ADR.

**The test helpers wait on time.** `until` (shared/test-helpers.mjs:47) polls every 20 ms and fails at 5× its budget; `untilHeard` rewrites a nudge file every 2 s so fs.watch fires again; `boardSees` polls `/api/board`. Once the server and hub expose `settled()`, all three are deleted with shared/test-helpers.test.mjs's test of `until`, and docs/adr/2026-11-12-1110-a-test-waits-on-state-and-fails-only-at-5x-its-budget.md is superseded for the main suite.

**Stand-ins live for fixed times.** Fake `claude` scripts that exit after 2, 5 or 20 s (headless.test `oneLaunchBoard` and 539/588, agents.test 94) change what the server sees partway through a slow test. `untilTestEnds()` already exists for this and is the fix (S5).

## Results that load changes today

Fix these first: under load they fail, or pass without testing, rather than only running long.

| test | what happens under load |
|---|---|
| server-builds 79, 90 | builds counted against late fs.watch events; ±1 tolerances and re-taps hide it |
| server.test 1094 (churn) | 1250 ms fetch abort fails the test; a 1 s negative sleep |
| server.test 1859 (idle push) | a swallowed 1.5 s wait, then the tick runs before the write is read: wrong result, not a timeout |
| server.test 795, 829, 1974, 2019 | unfiltered events.jsonl counts before and after; a late pass from the test before appends between them (from the code; not seen failing) |
| server-stale (every `tick()`), headless (300/400/800 ms sleeps) | NEGATIVE-SLEEPs pass without testing when the server hasn't run its pass yet |
| headless 539, 588, `oneLaunchBoard` | the fake builder's 5 s or 20 s life ends mid-test: a relaunch or a freed slot changes the counts |
| boards.test 383, 396 | the hub's own first poll at start + 60 s races the test's manual poll |
| gate.test 126 | "a failed read is not retried at once" holds only inside ownerGate's real 5 s retry |
| try.test 1172 | a 0.6 s fake-git window raced by a 20 ms poll; a miss waits out the 150 s ceiling |
| try.test 1218 | the hub's 15 s tick reads the real load and answers 409 |
| suite-run 19 | the quick file is still running at the 8 s cutoff and is named as hung |
| agents.test 94 | the fake agent's fixed 2 s life against launcher start-up |
| land-queue 133, 157, 170, 185 | assert a wake within 1000 ms |
| board-builder 460, 491 | transcript times 5 s from a CLI-spawn window |
| ui.test 2519 | 1 s of slack on "busy under a minute" |
| view.test 4089 | a minute rollover between two `new Date()` reads |
| restart-board 110 | reads `signalCode` before SIGCHLD has been handled |
| arch-review 15, ui.test 1699 | a run across midnight changes the expected date or "today" (not load, but clock) |

## Timing checks and where each goes

No check in the main suite measures speed that a person would act on except the churn latency. The rest assert behaviour through a stopwatch and are rewritten or deleted.

| test | check | goes to |
|---|---|---|
| server.test 1094 | the board answers within 250 ms (warn) / 1250 ms (fail) while thousands of lock folders churn | **bench** (S7). The main suite keeps "lock folders send no change" as a unit on `ignored()` / `heard()` (S2) |
| server.test 1062, 1094 | the real OS watch hears a rename, a new folder and a write during churn | **bench** (S7): only a real watch tests the OS; the main suite calls `heard()` |
| land-queue 133, 157, 170, 185 | the waiter woke within 1000 ms of the lock freeing | **rewrite** (S1): mock setTimeout so the 5 s recheck can't fire; the waiter finishing proves the watch woke it |
| locks.test 12 | a dead holder's lock is taken in under 1000 ms | **delete** the elapsed check; taking it with `timeout` below `staleAfter` proves "at once" |
| board-items 356 | `built_at` within 60 s of now | **delete** the window; bracket with before/after as lines 10–14 of the same file do |
| sessions.test 247 | start returns in under 10 s | **delete**; the fake's lingering child runs `untilTestEnds()`, so a start that waits on it never returns and the per-file timeout catches it |
| boards.test 686 | `created` within a second of now | **delete**; assert it parses and survives the rejoin |
| prompts.test 362 | the hook took ≥ 1400 ms; under 2500 ms; unreachable under 1000 ms | **delete** the ms checks; fake the hook's clock and fetch by `--import` preload (as prompts.test:299 does) and assert the deny and the DELETE |
| try.test 979 | a 3.5 s fake git fetch finishes under the 10 s limit | **delete** the sleep; it re-measures a constant (hub/try.mjs:956) |
| suite-run 53 | node's own per-test timeout fires | **rewrite**: a test that never resolves times out at any load; check `testArgs` and TAP parsing as data |
| shared/test-helpers.test 8 | `until` warns past its budget and fails at 5× | **delete** with `until` |
| server.test 745, 1336 | a hold or pause end within 60 s of now + 3 h / 1 h | **rewrite** (S1): the server's clock frozen, assert the exact end |
| statusline.test 128 | first stdout chunk within 3 s | **rewrite** (S6): await the chunk with no timer |

The bench is new: `npm run bench`, running `*.bench.mjs` files that `board.mjs test`, lands, builders and the full suite never pick up. It starts with the server.test rows above.

## Fix tasks

Grouped by seam. Sizes: S under a day, M a day or two, L more. Tasks that share a seam say so; a task that needs another's seam names it.

### F1. The board server starts in process (S2, S3, S1) — L

`board/server.mjs` exports `startServer({site, home, port = 0, now, launch, push, merge, ps})` → `{server, changed(name), minute(), settled(), close()}`; the script's top level calls it. `now` replaces the frozen-Date `--import` setups; `minute()` replaces the 60 s interval (and the 20 ms / 50 ms shrunk ticks); `settled()` resolves once the passes a change or a request started are done; `changed()` stands for an fs.watch event. `launch`, `push` and `merge` come from F3 and F6; until then they default to today's env-driven spawns.

First conversions, to prove the seam: server-builds (all rows; its read counter becomes the build count and the ±1 tolerances go), server-merge, arch-review, done-archive, ticket-paths, repo.test. Then follow-on tasks, each M once F1 lands:

- **F1a** board/server.test.mjs: every `boardSees` / `untilHeard` / `cardsMarkedRead` row; the event-count races (await `settled()` before the "before" count); the churn and stream tests split into `heard()` units plus the bench rows above; the watcher rows wait for F5.
- **F1b** board/server-stale.test.mjs: `advance()` + `minute()` + `settled()` replace every `tick()` sleep and `until`; restarts become `close()` then `startServer()` on the same files.
- **F1c** board/headless.test.mjs: as F1b, with F3's launcher replacing the fake `claude` scripts. Done by #667, with `startServer`'s `launch` (F3's server half) and the liveness reads left real: docs/adr/2026-11-14-0009-the-board-server-takes-the-launcher-its-tests-pass.md.

Shares S3 with F2 (one `settled()` pattern for both scripts) and needs F3 for the launch rows.

### F2. The hub starts in process (S2, S3, S1, S4) — L

`hub/hub.mjs` exports `startHub({home, port = 0, now, readMachine, probe, run, gate, ticks: false})` → `{reconcile(), tick(), poll(), endUnshared(), settled(), close()}`. `readMachine` ends the real-load read in tests; `ticks: false` with explicit `tick()` / `poll()` ends the 60 s first-poll race; `gate` passes `ownerGate({now, retryMs})`, which already takes both (board/on-host.mjs:58).

Converts: boards.test (setup, 300, 383, 396, 534, 693, 804, 870, 996), gate.test, join.test, stale-board (plus a pure reconcile decision, hub/hub.mjs:400-410), prompts 422 and 451, awake (with S4 on `caffeinate()`), linear, slack, rules, restart-board, restart-hub, view.test 1796 (its shell half moves to an in-process stub), try.test 1218. Several boards.test rows need no refactor and can go first in this task: 581 (`sendWakes`), 589 and 631 (`checkListening` / `listenState` with `running`), 870's down_since half (`checkSessions`), 959 (`migrateHubBoard`); those injection points exist.

### F3. Agents launch through an injected launcher (S4, S5) — M

`launchAgent`, `launchBuilder` and `resumeBuilder` take a `launch` (board/agents.mjs:60, board/headless.mjs:342, :387) that F1's `startServer` passes through. The test's launcher records the argv and returns a pid and session, so fake `claude` scripts, their 5/20 s lifetimes, `launchesGone` (inside every server.test `putWave`) and the pid-alive checks go. Cheap part, no refactor, do first: the stand-ins that live for a fixed time use `untilTestEnds()` (headless `oneLaunchBoard`, 539, 588; agents.test 26, 46, 94), and every `child.kill()` before `rmSync` awaits `'exit'` (headless 218, 325, 403, 539, 588, 903). Also board-land 943, 982.

### F4. The try manager settles (S3t, S1, S4) — L

Built in #657: docs/adr/2026-11-13-2215-the-try-manager-settles-and-takes-a-runner.md, which says why the probe interval stays real.

`createTryManager` (hub/try.mjs:150) gains `settled()` / `next(key, state)` resolved in `update()`, a `run` for git / ps / lsof (ends the 3 s git limit and the real `ps` + `lsof` at 858, 881, 1562, 1577), a `grace` for `endGroup` (today a fixed 4 s, try.mjs:76; test 1303), and its 250 ms probe interval under `t.mock.timers`. `fetchTryBranches` and `pullMains` pass `run` through as `pullBranch` already takes it (955–1172). Converts hub/try.test.mjs: its `until(state()…)` waits become `await manager.next(…)`. 1172's race becomes a fake git that blocks until released (S5). 1218 waits for F2.

### F5. wait-events runs in process (S1, S5) — M

`bin/wait-events.mjs` exports `watch({route, session, sleep, sessionGone})`; its 2 s loop and 2 s batch (bin/wait-events.mjs:133, :157) run on an injected `sleep`. Converts wait-events.test (every NEGATIVE-SLEEP: 48, 75, 109, 117, 168), and the watcher rows of server.test (862, 1455) and close-board 249. A smaller first step that needs no refactor: the watcher writes a pass count to watcher.json, and the tests await `checks ≥ n` instead of sleeping 2.5–5 s; and test 184 passes `stallingPs(home, standIn)` so no real `ps` runs.

### F6. ps, locks and push take their runner (S4, S1, S5) — M

- `hub/live.mjs`: a `ps` option on `liveSessions` / `processStarts` / `parentOf`; `stopRuns` takes `{ps}` (board/headless.mjs:264). Converts live.test, orchestrator-stops (44, 64, 91, 113, 142, 161, 271), watcher-stop 14, sessions 724.
- `hub/locks.mjs` `withFileLock`: `{now, wait, onWait}`. `onWait` is the signal lanes 141 and close-board 212 need instead of 300 / 250 ms sleeps; `now` / `wait` convert locks.test 23 and 32. merge3 and board-items 295 keep their processes (cross-process locking is the point) and run with no lock deadline under test.
- `hub/push.mjs`: an injected fetch and home, so push.test runs in process (72's 4 s needs read) and board-threads 201, 226, 246 follow; the server's push stub (`KICKFLIP_PUSH_CMD`) becomes F1's `push`.
- `store.listAsks` / `store.waitHelper` already take `every`; add `now` and test them in process with mock timers: board-builder 141, 706, 767; card-pause 90.

### F7. Renderers take `now` (S1) — M

Done by #660 with a frozen sandbox Date in place of a `now` on each renderer: docs/adr/2026-11-13-1417-ui-tests-freeze-date-in-their-sandbox.md.

Every board and hub renderer that reads the clock takes `now` (`ago`, `since`, `lasted`, `shortSince`, `statusLine`, `githubLine`, `builderLine`, `workLines`, `hubDot`), and ui.test builds its data from one fixed `NOW`. Converts ui.test (2519 first, then the clock-read group and 1699) and view.test 4089 (freeze `win.Date` in `fakePage`). view.test's `until` waits on fake fetch and IndexedDB chains (1268–1705) become a `drain()` that loops `setImmediate` until the fakes are idle: no clock. Also board-messages hook (freeze Date by `--import`) and board-builder 460, 491 (transcript times from the records' own `started`).

### F8. Test-side clean-ups with no product change (S6, S8, S1) — S

Each is local to its test file:

- Delete the timing checks marked delete above, and rewrite land-queue's wake checks and suite-run 19 and 53 (S1, a cutoff trigger).
- Drop `timeout:` from spawns whose limit only fails a slow run: server.test 1819 and 1859, repo.test 12, try.test's fixture `git()` (62). Drop `dumpProbe`'s 60 s exec timeout and retry (the Chrome layout files) and prototype-phone's.
- Use port 1 for a "down" hub, as boards.test:86 does: board-builder 337, join 202, boards 76, prompts 379. Use `listen(0)` in process: watcher-stop 45.
- Replace readiness sleeps with the event: card-pause 37 and 122 (`'spawn'`), statusline 128, close-board 249's 30 s reject, gate.test's 5 s stream rejects and its sleep 300 at 245 (assert right after both streams open), shell.test 189 (a marker change on the other board, then FIFO order).
- Await `'exit'` before reading `signalCode`: restart-board 110. .kickflip/build.test: await the port line and the stop with no reject timers, and replace its 1 s sleep before asserting tailscale was never called with a signal that the demo hub finished starting (S5). Delete boards.test's 200 ms sleep before `rmSync` (273).
- `hub/shell.mjs`'s `hubStream` takes `watch` (shell.test 159) and its retry and settle timers run under `t.mock.timers` (125, 189).
- Assert in-flight checks with a counter, not a 20 ms sleep: try.test 1035; assert `endUnshared()` synchronously: try.test 661.

### F9. Product time limits (S4 or delete) — M

The limits in the table under [What the audit found](#what-the-audit-found) that F2, F4 and F6 don't already cover: `kickflip`'s 1.5 s hub status (drop it: a hub that is down refuses at once), `listBuildTargets` (a `run`), `SESSION_WAIT_MS` (a `sessionWait`), `withinWait` (`KICKFLIP_PEOPLE_WAIT_MS` exists; S4 the Slack and gh lookups), the permission hook (a `runHook({fetch, now, sleep})` export, or the preload already used), the status line (export `statusLine({git})`), render-check's settle windows (await CDP's `Page.loadEventFired`; until then render-check.test runs only on the bench's command). Each changes shipped behaviour on a slow host and gets its own ADR.

### F10. The perf bench — S

`npm run bench` runs `*.bench.mjs`; `board.mjs test`, `affectedTests` and the release workflow never select them. Moves in the server.test churn latency and the real-watch checks (with F1a), and keeps docs/adr/2026-11-12-2135-the-folder-churn-test-builds-its-site-aside-and-bounds-its-churn.md's site setup.

### Order and sharing

- F8 and F3's cheap part first: no product change, and they remove several of the flakes listed above.
- F1 then F1a–F1c: the land-blocking files. F3 rides with F1c; F6's push and ps runners plug into `startServer`.
- F2 next; its no-refactor boards.test rows can go any time.
- F4, F5, F6, F7, F9 are independent of each other.
- F10 lands with F1a, which moves its first rows.
- When no test calls `until`, `untilHeard` or `boardSees`, delete them (F1 and F2's last conversion).

## Per file

Each table row is a call site or a group of them. Line numbers are the test's `test(` line, or the line the row names. "Injection point exists?" says whether the module under test already takes the seam's option, citing the source.

### .kickflip/build.test.mjs
Spawns the repo's build script, which starts a demo hub (hub/hub.mjs) on a port it picks and prints `port <n>`. The waits are hand-rolled timers around that child.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 9 | the repo build script announces a private working hub that never runs the host's tailscale, and stops with its process group | `setTimeout` 30 s rejects unless the `port` line comes first; the demo hub starts a real hub.mjs, whose 15 s tick reads the real load | PROCESS, MACHINE | S6: await the line with no timer | n/a (test-side) |
| 9 | same | `fetch` of `/_hub/status.json` under `AbortSignal.timeout(5000)` | PORT | S6: no abort; the per-file timeout is the ceiling | n/a |
| 9 | same | sleeps 1000 ms, then asserts the fake tailscale was never called | NEGATIVE-SLEEP | S5: the build script prints a line once the hub's startup pass is done, and the test asserts after it; or F2's in-process hub with an injected tailscale | no |
| 9 | same | after SIGTERM, `setTimeout` 5 s rejects unless the group closes; `t.after` waits up to 5 s before SIGKILL | PROCESS | S6: await `'close'` | n/a |

Shared seam: S6 for the three timers; the negative sleep needs a startup signal. Size: S.

### bin/join.test.mjs
`before()` (56) spawns the real hub (awaited by its "hub on" line, no limit) and an http page server on a `freePorts(3)` port. Every `kickflip join` is a spawned CLI awaited on close (no limit), but it calls the hub with a 1.5 s cap (finding 3). The dominant wait is `until` on the sidebar while the hub's 2 s reconcile probes.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 15 / 56 (file) | (setup; all tests) | `freePorts(3)` race on `port`/`pagePort`/`learnPort`. The hub's 15 s tick reads real load. Every join's `hubStatus()` 1.5 s cap: 108 and 139 assert `hub: 'running'`; 226, 267, 278 and 293 fail outright on a slow hub. | PORT, MACHINE | S6: drop the 1.5 s abort (kickflip.mjs:302). S3/S4 for the hub. | no |
| 105 | join --port puts a server the session runs at /<route> under Pages with no owner, watcher or needs, and it reads down once that server stops | `until` up (115: the 2 s reconcile probes the port); `until` down (122: needs `MISSES`=3 consecutive failed 2 s probes, answering.mjs:3, about 6 s); `until` back up (128) | WAIT-ON-TIME (server 2 s tick) | `createAnswering()` is pure (answering.mjs:5): table-test the up→down→up sequence there. The hub wiring goes to S3 with an injected `probe` and `await reconcile()`. | Partial (answering yes; hub probe hub.mjs:349 no) |
| 163 | --watch with --session is today's join: the starter kit, the owner, the watcher and the Needs you badge… | `until` the starter server's health (174; the hub spawns starter/server.mjs); `until` the sidebar badge counts needs.json (177) | PROCESS, WAIT-ON-TIME | S3 + S4 (injected spawn) | no |
| 186 | leave takes a plain page off without a session, and still asks for the owning session on a watched site | `until` the starter server stops (197) | PROCESS | S3 `settled()` after the manifest change, with an injected spawn whose stop resolves | no |
| 202 | kickflip join refuses a folder outside git, says to run kickflip init while the hub is down… | `freePorts(1)` "down" port (209). If something binds it, `hubStatus` may answer and the message changes. | PORT | Use port 1 (refused at once), as boards.test:86 does | yes (env) |

Time only, result fixed (beyond the file-level 1.5 s cap row): 131, 223, 261, 274, 290 (CLI, git fixtures, fake tmux and claude awaited on close).

Shared seam: dropping the 1.5 s cap is a one-line change that removes the biggest result risk in the file. The `until` rows need the hub refactor (S3). Size: S for the cap and port fixes, M with the hub.

### bin/statusline.test.mjs
Spawns `bin/statusline.mjs` with spawnSync, and once as a live child. The main wait is the status line's own 500 ms git timeout (`bin/statusline.mjs:13`).

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 24 | status line prints the exact directory, branch, model and context for clean, unstaged and staged repos | the script's git calls each have a 500 ms timeout, so a slow git drops the branch or `*`. The test retries up to 5 times (`inRepo`) and fails if all 5 time out | WAIT-ON-TIME (production timeout, retried) | S4: inject the git runner (export a `statusLine({git})` function from the script), or let a test set the timeout | no. `bin/statusline.mjs:13` hardcodes `timeout: 500` in a top-level script |
| 128 | status line flushes output before attempting a blocked usage read | `setTimeout` 3000 ms rejects unless the first stdout chunk arrives first, so a slow node start fails | PROCESS | S6: await `once(child.stdout,'data')` with no timer. The FIFO already keeps the child blocked | n/a (test-side only) |

Excluded: lines 79/89 and 152/157 bracket a timestamp between `before = Date.now()` and `Date.now()`, which holds at any load. The rest is plain spawnSync with a fixed result, so only the run time varies.
Shared seam: none. Size: S.

### bin/wait-events.test.mjs
Starts the real wait-events.mjs (a top-level script) as a child, plus stand-in session processes, real or stalling ps, and lookalikes. The main wait is the watcher's own **2 s poll loop plus 2 s batch** (wait-events.mjs:133, :157), with no injection point. Tests await the child's exit (S6 already) and use fixed 2.5–5 s sleeps for "it hasn't woken". sessionGone reads real ps with a 3 s timeout (hub/live.mjs:45), env-overridable by KICKFLIP_PS_TIMEOUT_MS.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 11 | paused watchers hold hub work through owner wakes and restarts… | `{timeout: 120000}`; `until` watcher.json (47); **48: sleep 2500 then asserts the watcher has not exited or printed**; `await first.done` (S6) after the 2+2 s loop; `until` replacement pid (74); **75: sleep 2500 then asserts not exited**. Real ps on the test pid each pass | NEGATIVE-SLEEP / PROCESS / MACHINE | S5: the watcher records each finished pass (e.g. `checks: n` in watcher.json), and the test awaits n≥2 after its state is in place, not 2.5 s. Under load 2.5 s can pass before one pass, so the negative check **passes vacuously**. Better: refactor the loop body into an importable `pass(state)` and drive it in process with S1 | no (top-level script, constant 2000 ms) |
| 88 | a board's own pause holds its hub work as a usage pause does… | `{timeout: 60000}`; **109: sleep 5000** (the only wait for the watcher to start, no `until` watcher started) then asserts not exited; `await first.done`; **117: sleep 3000** then asserts not exited | NEGATIVE-SLEEP / PROCESS | S5 pass counter, as 11 | no |
| 156 | a watcher whose session dies exits without taking the next event… | `{timeout: 60000}`; three nested stand-in processes (untilTestEnds); IPC message (S6); `until` watcher pid (165); **168: sleep 2500 then asserts the orphan still runs**; `until` orphan gone (174), which waits the 2 s loop and a **real ps** sessionGone read (3 s timeout) | NEGATIVE-SLEEP / PROCESS / MACHINE | S5 pass counter for 168. For the ps read, the stallingPs `standIn` (test-helpers.mjs:178) or injecting `sessionGone` (live.mjs:93 takes `ppid/parent/live`) into an importable watcher | live.mjs yes; watcher no |
| 184 | a watcher keeps waiting while ps can't answer whether its session runs… | `{timeout: 90000}`; KICKFLIP_PS_TIMEOUT_MS=200 with a **passthrough real ps** (no `standIn`). Once unstalled, the real ps must answer in 200 ms; under load it doesn't, the watcher reads "can't tell" and keeps waiting (time grows, result held only by the 90 s ceiling). `until` stalls≥4 (197); `await done` | PROCESS / MACHINE | Pass `stallingPs(home, standIn)` so no real ps runs (the helper already supports it); S5 pass counter | yes (standIn option) |
| 206 | a new watcher for the same session stops the one watcher.json records… | `{timeout: 60000}`; lookalikes (untilTestEnds); `until` ×3 (213, 218, 226); awaits SIGTERM exit (S6); a wake waits the 2+2 s loop | PROCESS / WAIT-ON-TIME | S6 kept; S5 for "started" (watcher.json already is the signal; the `until` polls it) | partly |
| 233 | record-only events and pings do not wake the session… | `{timeout: 60000}`; `until` watcher.json (244); `until` cursor===6 (248) and ===14 (262), each over the 2 s loop; asserts not exited at those points (state-based, sound); `await exited` | WAIT-ON-TIME / PROCESS | S5 pass counter, or in-process `pass()` + S1 | no |
| 278 | on a board a new task wakes the session with its sort line… | `{timeout: 60000}`; `until` (288); `await exited` after 2+2 s | PROCESS | S6 is fine; in-process `pass()` would make it instant | no |
| 296 | a wake prints a message the PostToolUse hook already showed again… | `{timeout: 30000}`; `await watch().done` (2+2 s) | PROCESS | as 278 | no |
| 310 | a wake that prints an ask edit moves the ask's working mark to now… | `{timeout: 30000}`; `await done`; `Date.parse(marks.a1) >= before` (real clock, one direction only, so the result is fixed) | PROCESS | as 278; the clock check could use S1 for an exact value | no |

Excluded: `Date.now() + 3600_000` (18, 93) and `Date.now() - 1000` (77) are data relative to now, far from any edge. `Date.now() - 2 * 3600_000 - 30_000` (54) feeds the "for 2h" text: 2 h 30 s of margin before the rounding changes.

**Shared seam:** one S5, a pass counter the watcher writes after each loop pass, fixes every NEGATIVE-SLEEP (48, 75, 109, 117, 168) and makes them prove something under load. The full fix: make wait-events.mjs an importable `watch({route, session, sleep, sessionGone})` and test passes in process with S1, which also drops each test's 2–4 s loop time. Size: **M** (the S5 counter alone is S).

### board/agents.test.mjs
launchAgent spawns a fake `claude`/`codex` node script, detached. It reads the session id by polling the log every **100 ms** under a **SESSION_WAIT_MS 15 s cap** (agents.mjs:38–51), or at the child's exit. Fakes stay alive for `stay` ms via a real setTimeout.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 26 | launchAgent runs claude -p in auto mode… | fake starts and prints init; 100 ms poll; **15 s cap**: if the fake node takes >15 s to start under load, sessionId is null and the assert fails. `stay: 3000` leaves the child running 3 s past the test (leaked process, a T-290 concern) | PROCESS | S1 for the cap (mock setTimeout/setInterval, or inject `sessionWait`). The fake doesn't need `stay` (exit triggers a final scan), so drop it to stop the leak | no (SESSION_WAIT_MS const; spawn not injectable) |
| 46 | launchAgent runs codex exec in the worktree… | same, `stay: 3000`, fixture git (no timeout) | PROCESS | as 26 | no |
| 66 | launchAgent gives no session id for an agent that exits without one… | fake exits at once, so exit resolves | PROCESS (time only) | none needed | n/a |
| 76 | launchAgent stops watching the log once it has the session id… | `stay: 500`; `until` the agent exits (87); **88: sleep 200, then asserts no uncaughtException** (nothing fired after exit) | NEGATIVE-SLEEP / PROCESS | S1: with setInterval mocked, after launch resolves, `t.mock.timers.tick(…)` far ahead and assert no throw. Any leftover poll would run at once, deterministically. Or have the fake stay until a release file (S5) and await its 'exit' (S6) | mock timers need no injection; the poll is internal |
| 94 | an agent launched by a process that is then killed keeps running… | launcher process prints pid (S6); SIGKILL launcher; **asserts the agent still runs, but the fake only stays 2000 ms** from its own start. Launcher start + launchAgent + kill can exceed 2 s on a loaded host, so the agent has exited and `doesNotThrow` fails (**load decides the result**). Then `until` it exits (109) | PROCESS | S5: the fake stays until the test writes a release file (or `untilTestEnds()`); assert alive, release, await exit (S6) | n/a (test-side fake) |

**Shared seam:** a fake agent that stays until released (S5) fixes 94 and the leaked 3 s children in 26/46. S1 or an injected `sessionWait` covers the 15 s cap and 76. Size: **S**.

### board/arch-review.test.mjs
Each test spawns `board/server.mjs` on a `freePorts` port and awaits `boardListening`. The main wait is `until` polling `/api/board` until fs.watch has heard a write.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 35 (helper `boardServer`, used by all 5 tests) | all tests in the file | spawned server on a port from freePorts. The port can be taken between freePorts and listen. Readiness comes from `boardListening` (no timer) | PROCESS, PORT | S3: in-process `startServer()` on port 0 | no. server.mjs is a top-level script |
| 75 (in 50) | Run makes a wave whose first card is the audit, … | fs.watch hears the owner.json write, polled via `until` (30 s budget, fails at 150 s) | WAIT-ON-TIME | S2+S3: call `changed()` then await `settled()` | no |
| 85 (in 50) | same | fs.watch hears the `putWave` item-file write, polled via `until` | WAIT-ON-TIME | S2+S3 | no |

Also, not load: line 15 computes `stamp`/`title` from the real date when the module loads, while the server stamps its own `new Date()`. A run that crosses midnight between the two fails. Freeze Date with an `--import` setup (S1).
Shared seam: S2+S3 fixes every row. Size: M once server.mjs is importable.

### board/board-builder.test.mjs
Mostly spawnSync of the board CLI, where only the run time varies. The waits come from the CLI's own 2 s poll loops (`store.listAsks`, `store.waitHelper`, `every = 2000`).

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 141 | builder asks --wait returns once every ask is answered and fails after its timeout while one waits | `--timeout 0.001` (60 ms) deadline read off `Date.now()`, then a real 2 s `setTimeout` before it fails. The result is fixed, but each run costs ≥2 s | WAIT-ON-TIME | S1: call `store.listAsks` in-process with `t.mock.timers` (Date + setTimeout), or `every: 0` | partly: `board/store.mjs:4890` takes `every` and `timeout`. The deadline uses `Date.now()` |
| 337 | builder start stores the installed link for the kickflip fallback repo, … | `freePorts()` picks a hub port that nothing serves, so the CLI's hub call is refused. A stranger binding that port would answer instead | PORT (minor) | S8 for the port: use `KICKFLIP_HUB_PORT: '1'` as board-fixture does | n/a |
| 706 | agent launch asks for a helper on an open card, … | `agent wait --timeout 0.0001` (6 ms) waits out one real 2 s poll before it fails | WAIT-ON-TIME | S1: `store.waitHelper` in-process with mock timers | partly: `board/store.mjs:4667` takes `every` and `alive`. The deadline uses `Date.now()` |
| 767 | agent wait marks its spawner waiting while the helper is open, and refuses once the helper's process is gone without its done | `runAsync` child CLI. `until(record().waits === 'look')` (30 s budget). The child then notices the dead pid on its next 2 s poll | PROCESS, WAIT-ON-TIME | S1+S4: call `store.waitHelper` in-process with an injected `alive` and mock timers. Tick, assert the mark, flip `alive`, tick | yes for `alive` and `every` (`board/store.mjs:4667`). Not for the clock |
| 460 | the SubagentStop hook closes the builder records its agent started and left open, quietly and any number of times | transcript times are `ago(1000)` off the real clock. The hook accepts a record only if it started within `[command − 5 s, result + 2 min]` (`board/bin/builder-stop-hook.mjs:12-13,56`). The `bench` record starts before 2 more CLI spawns, so if those take more than ~6 s the record falls outside the window and the test fails | WAIT-ON-TIME (real-clock window, 5 s margin) | S1: write transcript times from the records' own `started` (read back from the file), not `Date.now()` | n/a (data only) |
| 491 | the SubagentStop hook leaves the records open while background work the agent started still runs, … | same window, with `ago(1000)` and one CLI spawn before it | WAIT-ON-TIME (5 s margin) | S1, as row 460 | n/a |

Excluded: line 486 sits 10 minutes out on purpose, so it is robust. Line 621 (usage `at: now`, freshness window measured in minutes) and line 772 (only orders session.at before started) carry no tight margin.
Shared seam: S1 with in-process store calls fixes rows 141, 706 and 767. Data-only fixes cover 460 and 491. Size: S–M.

### board/board-items.test.mjs
Board CLI through spawnSync, so mostly only the run time varies.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 295 | appends from several commands at once each survive, under the card's lock | 4 concurrent CLI processes contend for `withFileLock`. Each waiter polls every 100 ms and fails ELOCKED after a 10 s `performance.now()` deadline (`hub/locks.mjs:15-24`). Heavy load can push a holder past 10 s | PROCESS (lock deadline) | S4: run the 4 appends in-process with `Promise.all`, and/or a lock wait with no deadline in tests | partly: `withFileLock` takes `timeout`. The notes CLI path passes none |
| 356 | item set --install records a device build with when it was built, … | `assert.ok(Math.abs(Date.parse(built_at) - Date.now()) < 60000)` | TIMING-CHECK | delete the 60 s window. Bracket it with `before`/`after` as lines 10–14 of the same file do. It measures nothing to do with speed | n/a |

Excluded: lines 10/14 and 331 are before/after brackets. Lines 691, 1011 and 1053 are future dates with margins of hours or more and only order against earlier writes.
Shared seam: none. Size: S.

### board/board-land.test.mjs
Board CLI through spawnSync. `land` runs `node --test` on a fixture repo with the product's 5 min per-test and 15 min run limits (`board/worktree.mjs:178`). Those limits never bind on the one-file fixtures, so those tests only vary in run time. The real waits are on a fake `claude` the CLI launches detached.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 943 | a tapped Merge whose rebase conflicts launches a headless lander, and the lander finishes it onto main with no second tap | the merge CLI exits after `launchAgent` spawns the fake claude detached. `until(fs.existsSync(seen))` (30 s budget) waits for the fake to write | PROCESS, WAIT-ON-TIME | S4: inject the launcher into `launchBuilder` → `launchAgent` and assert its argv in-process. Or S5: the fake writes `seen` then the test awaits a fifo/line with no timer | no. `board/agents.mjs:60` `launchAgent({bin})` swaps the binary but still spawns. `board/headless.mjs:342/355` passes no launcher |
| 982 | a tapped Merge whose rebase conflicts resumes the card's builder session, … | same, `until(fs.existsSync(seen))` | PROCESS, WAIT-ON-TIME | S4, as above (`headless.mjs:390`) | no |

Excluded: line 64/798 `reset` and line 527 `since <= Date.now()` are data or brackets. Line 1139 sets future-dated helper times as data.
Shared seam: an injected launcher (S4) fixes both rows. Size: M.

### board/board-threads.test.mjs
CLI children talk to in-process stand-ins on ephemeral ports.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 8 | install posts only the route and key to the hub once it quotes the owner, prints started, and reports refusals plainly | an in-process stand-in hub on `listen(0)`. The CLI's POST aborts after 10 s (`AbortSignal.timeout(10_000)`, `board/bin/board.mjs:986`). Each run is a `runAsync` child | PORT, PROCESS | S4: call board.mjs `main` with an injected fetch (`ticketCli` already calls `main(argv, {linearFetch, run})`) | partly: `main` takes injected deps (board-fixture `ticketCli`). The hub fetch at board.mjs:984 is global `fetch` |
| 201 | a push without an allowed kind is refused with one line, … | `withDevice`: a fake device/hub on a port (`hub/fake-device.mjs`) plus `runAsync` children. Refusals happen before any fetch | PORT, PROCESS | S4: push.mjs with an injected fetch | no (`hub/push.mjs:122,139` use global fetch) |
| 226 | after a thread's push has gone, Claude's lines and replies there push nothing; … | `withDevice`. Each push POSTs to the device (15 s abort, `hub/push.mjs:145`) and first GETs needs.json (4 s abort, `hub/push.mjs:124`) | PORT, PROCESS | S4 | no |
| 246 | a reminder the owner asked for goes out as kickflip push sends a fault | same | PORT, PROCESS | S4 | no |

Excluded: lines 132/140/171 set reply mtimes and last_push relative to now. The code compares them only with each other or with a later now, so ordering is fixed.
Shared seam: an injected fetch in hub/push.mjs fixes rows 201, 226 and 246. Size: M.

### board/card-pause.test.mjs
Detached sleeper processes stand in for builders. `runAsync` CLIs.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 37 | blocking a card In Progress asks its builder to pause: … | `fakeBuilder` then a raw `setTimeout(200)` that stands for "the process is up" | PROCESS (fixed sleep for readiness) | S6: `await once(child,'spawn')`. The pid exists once spawn returns, so the sleep can simply go. Or S4: an injected `alive` | n/a (test-side) |
| 90 | a builder waiting on its ask is already at a stopping point, so builder asks --wait returns the pause at once | `setTimeout(800)` so the `--wait` child reaches its poll before the block lands, then the child's 2 s poll. Under load the block can land first, and the test then passes down a different path (pause seen at once) | WAIT-ON-TIME | S1: call `store.listAsks({wait:true})` in-process with mock timers. Await the first `builderAsks` read (or tick 0), set the block, tick `every` | partly: `board/store.mjs:4890` `every` option |
| 122 | a bump-out pauses the build In Progress, naming the bump, and its record stays open | `fakeBuilder` + `setTimeout(200)`, as row 37 | PROCESS | S6, as row 37 | n/a |

Shared seam: drop the readiness sleeps (S6). One mock-timer row. Size: S.

### board/done-archive.test.mjs
Spawns `board/server.mjs` on a `freePorts` port. Waits on archive writes and fs.watch.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 143 | the server archives Done cards past the newest 100 as it starts, sends the rest slim, and pages the archive in 100 at a time | port from freePorts. "site on" awaited by its own listener (no timer) | PROCESS, PORT | S3 | no |
| 159 (in 143) | same | `until` the startup archive has written (30 s budget) | WAIT-ON-TIME | S3: `await startServer()` resolves after the startup passes, or `settled()` | no |
| 162 (in 143) | same | `until` `/api/board` shows the archived cards, which waits for the server's fs.watch to hear its own archive write | WAIT-ON-TIME | S2+S3 | no |

Shared seam: S3 fixes all three. Size: S–M once server.mjs is importable.

### board/headless.test.mjs
16 tests are pure brief or function tests. 14 spawn `server.mjs` on a real port (`freePorts`, then `listen`); the `oneLaunchBoard` ones use a real 60 s tick, or 50 ms with `fastMinute`. They use fake `claude` scripts that exit at once, live 5 s, live 20 s, or live until the test ends. They also hit HTTP `fetch` to the port. The waits that dominate are `until`/`untilHeard` and raw 300/400/800 ms sleeps before "nothing launched" asserts.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 218/260-264 | the server launches the builder for a tap and a pull… | `freePorts`, then server child on a real port; `boardListening` | PORT + PROCESS | S3 in-process server (HTTP via `server.emit('request')` or an ephemeral `listen(0)`) | no |
| 218/266 | 〃 | fake `claude` (exits at once) logs the lander run, `until` | WAIT-ON-TIME + PROCESS | S4 injected launcher + S3 | no |
| 218/271-274 | 〃 | POST tap over HTTP, then `until` the second run is logged | PORT + WAIT-ON-TIME | S3 (`send` in-process) + S4 | no |
| 218/285-299 | 〃 | HTTP GETs on the port, `/api/log` and `/api/transcript` | PORT | S3 (call the handler in-process) | no |
| 218/308 | 〃 | items write via fs.watch, `untilHeard`. Comment: the real 60 s minute check may relaunch the exited fake; the assert counts per run to tolerate it | WAIT-ON-TIME (fs.watch) + PROCESS | S2+S3+S4 | no |
| 218/314 | 〃 | owner.json write via fs.watch, `untilHeard` | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 218/315-317 | 〃 | `boardJSON` write, sleep 400 ms, then asserts one lander each | NEGATIVE-SLEEP | S2+S3 | no |
| 218/319-320 | 〃 | `child.kill()` not awaited, then `rmSync` of the dir the server may still write (ENOTEMPTY under load) | PROCESS (cleanup) | S6 await `'exit'` (as oneLaunchBoard's `cleanup` already does) | yes, pattern at headless.test.mjs:678-683 |
| 325/373-377 | the server starts a rebase run on each card whose open PR conflicts… | port + server child | PORT + PROCESS | S3 | no |
| 325/378 | 〃 | fake `claude` logs 2 rebase runs, `until` | WAIT-ON-TIME + PROCESS | S4 + S3 | no |
| 325/390 | 〃 | HTTP `/api/board` | PORT | S3 | no |
| 325/393-395 | 〃 | `boardJSON` write, sleep 400 ms, then asserts still 2 runs | NEGATIVE-SLEEP | S2+S3 | no |
| 325/397-398 | 〃 | un-awaited kill, then rm | PROCESS (cleanup) | S6 | pattern exists |
| 403/431-437,464 | a lander whose process is gone while its builder record is open… | port + server child, started 2× | PORT + PROCESS | S3 | no |
| 403/439 | 〃 | fake `claude` logs the lander, `until` | WAIT-ON-TIME + PROCESS | S4+S3 | no |
| 403/445 | 〃 | `until` landers.json has the pid and that real process is gone (`kill 0`) | PROCESS + MACHINE (real process table) | S4: an injected launch returns a pid, an injected `alive` | partly: `reviveBuilders({alive})` headless.mjs:316; the lander path in server.mjs:1899-1912 takes none |
| 403/452 | 〃 | record and wave writes via fs.watch, `untilHeard` relaunch | WAIT-ON-TIME (fs.watch) | S2+S3+S4 | no |
| 403/455 | 〃 | awaits server `'exit'` after kill, no limit | PROCESS (S6 already) | keep | n/a |
| 403/460 | 〃 | `execFileSync` board.mjs lander, the CLI under test, with no timeout | time only, result fixed | none | n/a |
| 403/465 | 〃 | after restart, `until` third run | WAIT-ON-TIME + PROCESS | S3+S4 | no |
| 403/467-468 | 〃 | un-awaited kill, then rm | PROCESS (cleanup) | S6 | pattern exists |
| 539/553-554 | the server's minute check relaunches a tracked headless builder… | spawns `node -e ''` and awaits `'exit'` to get a dead pid | PROCESS (S6 already) + MACHINE (pid reuse: the dead pid could be reused by the time the server checks) | S4 injected `alive` | `reviveBuilders({alive})` headless.mjs:316 exists; server.mjs doesn't expose it |
| 539/560 | 〃 | fake `claude` lives 5 s (`setTimeout 5000`, `untilTestEnds` unref'd). Comment: so "the 50ms check leaves its entry at relaunched". If the test outlives 5 s under load, the fake exits and the next 50 ms check hands it back. The `relaunched===true` assert survives (`handedBack` keeps it), but the state under test changes underneath | PROCESS (stand-in lifetime by time) | S5 stand-in that lives until the test ends (`untilTestEnds()` not unref'd), or S4 | yes: `untilTestEnds` test-helpers.mjs:162 |
| 539/562-570 | 〃 | `fastMinute` 60 s→50 ms real tick; port + server child | PROCESS + PORT + WAIT-ON-TIME | S1 explicit `minute()` + S3 | no |
| 539/572,574 | 〃 | `until` fake wrote its line; `until` tracked as relaunched | WAIT-ON-TIME | S3+S4 | no |
| 539/581-583 | 〃 | un-awaited kill; `stopFakeBuilders` SIGKILL not awaited, then rm | PROCESS (cleanup) | S6 | pattern exists |
| 588/611-614 | a restarted server launches the builder of an In Progress card… | port + server child (real 60 s tick) | PORT + PROCESS | S3 | no |
| 588/609 | 〃 | fake lives 5 s. If the test outlives the real 60 s tick and the fake has exited, reviveHeadless relaunches C1, `runs.length===1` (line 618) fails, and the `relaunched===false` wait (616) can miss | PROCESS (stand-in lifetime + 60 s tick) | S5 (`untilTestEnds`) + S1 `minute()` | yes, `untilTestEnds` |
| 588/615,616 | 〃 | `until` fake line; `until` tracked | WAIT-ON-TIME | S3+S4 | no |
| 588/621-623 | 〃 | un-awaited kill and `stopFakeBuilders`, then rm | PROCESS (cleanup) | S6 | pattern exists |
| 631 (helper) | `oneLaunchBoard` | `freePorts`, server child, real 60 s tick or 50 ms (`fastMinute`); default fake `claude` lives 20 s (`setTimeout 20000`), "as a planner does". A test past 20 s since a launch sees the planner gone, the record closed and a slot freed, which breaks the "second waits" asserts (rows below) | PORT + PROCESS (stand-in lifetime by time) | S3; S5 `untilTestEnds()` in place of 20000 | yes, `untilTestEnds` test-helpers.mjs:162 |
| 688 (helper `cleanup`) | `oneLaunchBoard` | awaits child `'exit'` (S6, fine), then `until` every agent pid is gone (30 s budget) | PROCESS + WAIT-ON-TIME | S6 await each child's exit (needs the child handle, i.e. S4) | partly |
| 695/703-705 | the owner's Grill and Prototype taps and a card arriving in Todo… | HTTP POST tap, sleep 300 ms, then asserts 0 runs | PORT + NEGATIVE-SLEEP | S3 `send` then `settled()` | no |
| 695/708 | 〃 | `until` waits file has the brief wait | WAIT-ON-TIME | S3 | no |
| 695/711,726,741 | 〃 | `writeBrief` via fs.watch, `untilHeard` launches ×3 | WAIT-ON-TIME (fs.watch) + PROCESS | S2+S3+S4 | no |
| 695/720,743 | 〃 | `until` the record has session.log (fake's init line read by the launcher) | WAIT-ON-TIME + PROCESS | S4 (the injected launch returns the session) | no |
| 695/735 | 〃 | agent and board.json writes via fs.watch, `untilHeard` arrival owes | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 695/737-738 | 〃 | sleep 300 ms, then asserts no launch | NEGATIVE-SLEEP | S3 | no |
| 695/746-748 | 〃 | brief while a planner is open, sleep 300 ms, then asserts no launch. Also depends on the 20 s fake lifetime (helper row) | NEGATIVE-SLEEP + PROCESS | S3 + S5 | no / `untilTestEnds` yes |
| 767/770 | a grill briefed during a pause waits on the card… | `fastMinute` 50 ms real tick; port and child | PROCESS + PORT | S1 `minute()` + S3 | no |
| 767/773-775 | 〃 | brief, sleep 300 ms, then asserts no launch while paused | NEGATIVE-SLEEP | S2+S3 | no |
| 767/778 | 〃 | usage file removed (read by the 50 ms tick), `until` launch | WAIT-ON-TIME | S1 | no |
| 767/782-783 | 〃 | sleep 300 ms, then asserts launched once (20 s fake lifetime matters) | NEGATIVE-SLEEP + PROCESS | S3 + S5 | no |
| 789/793 | within twice the buffer of the line the board starts one agent… | `fastMinute`; port and child; fake with init | PROCESS + PORT | S1+S3 | no |
| 789/796 | 〃 | briefs via fs.watch, `untilHeard` first launch | WAIT-ON-TIME (fs.watch) | S2+S3+S4 | no |
| 789/797-798 | 〃 | sleep 400 ms, then asserts the second hasn't launched | NEGATIVE-SLEEP | S3 | no |
| 789/800 | 〃 | the launch log write is read by a tick, `until` second launch | WAIT-ON-TIME | S1+S3 | no |
| 806/808-810 | a build whose builder fails to launch goes back to Todo… | port and child; HTTP POST; launch fails with ENOENT synchronously. Asserts right after the POST answer, no wait | PORT + PROCESS | S3 | no |
| 824/828-832 | stopAgents signals only the agents whose process started… | real `setTimeout` 50 ms waits for the `killAfter: 10` timer's SIGKILL | WAIT-ON-TIME | S1 `t.mock.timers` (tick 10) | yes: `killAfter` headless.mjs:264, global setTimeout mockable |
| 845/853 | the owner's Hold pauses the card's running builder… | port and child; fake `claude` lives to test end (`untilTestEnds`) | PORT + PROCESS | S3+S4 | no |
| 845/856 | 〃 | `until` the pull records the agent pid (start pass and fake init) | WAIT-ON-TIME + PROCESS | S3+S4 | no |
| 845/860 | 〃 | `process.kill(pid, 0)` on the real fake | MACHINE (real process) | S4 | no |
| 845/869 | 〃 | after SIGKILL and an unhold POST, `untilHeard` the resume relaunches | WAIT-ON-TIME (fs.watch) + PROCESS | S2+S3+S4 | no (`resumeBuilder` headless.mjs:387 has no launcher option) |
| 884/886 | Resume relaunches the grill a Hold stopped… | port and child | PORT + PROCESS | S3 | no |
| 884/890 | 〃 | brief via fs.watch, `untilHeard` launch | WAIT-ON-TIME (fs.watch) | S2+S3+S4 | no |
| 884/895 | 〃 | unhold POST, `until` relaunch logged by fake | WAIT-ON-TIME + PROCESS | S3+S4 | no |
| 903/915-917 | a stale lander entry for an archived Done card is dropped… | port and child | PORT + PROCESS | S3 | no |
| 903/913 | 〃 | lander pid `2**22+12345`, assumed dead on the real machine (above macOS's max pid, so it holds there) | MACHINE | S4 injected `alive` | no on the server path |
| 903/918 | 〃 | `until` the start pass drops the entry | WAIT-ON-TIME | S3 | no |
| 903/922-923 | 〃 | un-awaited kill, then rm | PROCESS (cleanup) | S6 | pattern exists |
| 941/943-945 | a new task launches no agent: it arrives as a New card… | port and child; HTTP POST | PORT + PROCESS | S3 | no |
| 941/949 | 〃 | `until` the intake wait | WAIT-ON-TIME | S3 | no |
| 941/950-951 | 〃 | sleep 300 ms, then asserts no run | NEGATIVE-SLEEP | S3 | no |
| 958/963 | the owner's visual request owes the orchestrator's visual brief… | port and child | PORT + PROCESS | S3 | no |
| 958/965-967 | 〃 | POST, sleep 300 ms, then asserts no launch | NEGATIVE-SLEEP | S3 | no |
| 958/970 | 〃 | brief via fs.watch, `untilHeard` | WAIT-ON-TIME (fs.watch) + PROCESS | S2+S3+S4 | no |
| 958/980 | 〃 | `until` session log recorded | WAIT-ON-TIME + PROCESS | S4 | no |
| 958/982-984 | 〃 | second brief, sleep 300 ms, then asserts it waits while the first runs. Fails if the first fake passed its 20 s life | NEGATIVE-SLEEP + PROCESS | S3 + S5 | no / `untilTestEnds` yes |
| 958/986 | 〃 | agent done write via fs.watch, `untilHeard` second launch | WAIT-ON-TIME (fs.watch) | S2+S3+S4 | no |
| 1022/1032 | a writing helper waits while the board has no implementer slot free… | port and child | PORT + PROCESS | S3 | no |
| 1022/1034-1037 | 〃 | helper record write, sleep 800 ms, then asserts no launch | NEGATIVE-SLEEP | S2+S3 | no |
| 1022/1039 | 〃 | record write via fs.watch, `until` (not `untilHeard`, so a lost fs.watch event waits until the 60 s tick) | WAIT-ON-TIME (fs.watch) | S2+S3+S4 | no |
| 1022/1049 | 〃 | `until` session log | WAIT-ON-TIME + PROCESS | S4 | no |

Excluded, with the reason:
- Pure tests with no wait, port or process (result and time are fixed): lines 26, 39, 57, 68, 77, 89, 163, 178, 473, 502, 517, 837, 928, 995, 1011. Also 192 (`briefFacts` on fs only).
- git `execFileSync` fixtures with no timeout (lines 223-233, 330-347, 408-411, 636-644, 1025-1027): time only, result fixed.
- `new Date()` / `Date.now()` used as record data: lines 448, 733, 838, 961, 985, 1029, 1034.
- `usageAt`/`reportUsage` (755-765) write timestamps relative to the real clock (at −10 min, resets +1 h), which the server reads on the same clock. They only break if a test runs past an hour.

Shared seam: the same in-process `startServer()` as server-stale fixes every server row:
- `settled()` replaces every 300/400/800 ms sleep and every `until`/`untilHeard`.
- `changed()` replaces fs.watch.
- `minute()` replaces `fastMinute`.
- In-process `send` and HTTP replace `freePorts` and the port.
- An injected launcher (needs `launchAgent`/`launchBuilder`/`resumeBuilder` to take a `launch` option) replaces all fake `claude` scripts. That deletes the 5 s and 20 s stand-in lifetimes and the pid-alive checks.
Cheap wins that need no refactor:
- (a) The `oneLaunchBoard` default fake and the 539/588 fakes: replace `setTimeout(…, 5000|20000)` with a non-unref'd `untilTestEnds()`. That removes the lifetime races now.
- (b) The tests at 218, 325, 403, 539, 588 and 903 kill without awaiting exit; await it as `cleanup` does.
- (c) stopAgents (824): `t.mock.timers`.
Size: L for the server refactor (shared). Then M to convert this file; S for the cheap wins.


### board/land-queue.test.mjs
In process except the last test, which spawns 3 node children. The main wait is fixed `sleep()`s standing for work, plus the lock's own wake: fs.watch, with a **RECHECK_MS 5 s** setTimeout fallback (worktree.mjs:299, :313). Three tests hard-fail on elapsed wake time.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 18 | a land that finds another card landing waits for it, saying whom… | sleep 300 inside the holder, sleep 50 before the second ask; the wake is fs.watch or the 5 s recheck | WAIT-ON-TIME (time only: the lock is taken synchronously and node timers fire by expiry, so the order is fixed) | a deferred promise the test releases (as test 157 already does), no sleeps | n/a (test-side) |
| 31 | lands waiting on one another go in the order they asked | sleep 300 holder, sleep 50, sleep 20 ×3; order comes from `asked` ms plus a counter (worktree.mjs:349), so it is fixed | WAIT-ON-TIME (time only) | deferred release; pass `asked` explicitly (the option exists) | yes (`asked`) |
| 120 | a land asked for a card already landing joins that land… | sleep 300 in the first, sleep 50; second part `sleep(100)` as work | WAIT-ON-TIME (time only) | deferred release | n/a |
| 133 | a land waiting for the lock wakes when it frees, not on a timer | sleep 200 / 50; **asserts `woke - freed < 1000` ms** (warns >100) | TIMING-CHECK → **rewrite deterministic, not bench**: the claim is "not on the timer", which is checkable without a stopwatch. With S1 (`t.mock.timers` on setTimeout) RECHECK_MS can never fire, so the waiter finishing at all proves the watch woke it. Await by S6 | S1 | mock timers work without injection; RECHECK_MS is a const (worktree.mjs:299), injecting it would be cleaner |
| 157 | a lock freed the moment its waiter starts watching still wakes the waiter | churnWatches (setInterval 1 ms opening/closing fs.watch); 5 loops; **`woke()` asserts <1000 ms** | TIMING-CHECK → rewrite with S1 as 133 (the 5 s fallback mocked away, success = watch or immediate re-check woke it) | S1 | as 133 |
| 170 | an ask ahead that leaves the moment its waiter starts watching… | same, `woke()` <1000 ms | TIMING-CHECK → S1 as 133 | S1 | as 133 |
| 185 | a land that ends the moment another joins it still wakes the joiner | sleep 10; `woke(Date.now() - ended)` <1000 ms | TIMING-CHECK → S1 as 133; the sleep 10 isn't needed (the marker is written synchronously) | S1 | as 133 |
| 201 | lands from separate processes go first in, first out | `{timeout: 20000}`; 3 node children (start + import worktree.mjs); `queued()` polls the queue dir every 20 ms with no budget (S6-like); awaits child exits | PROCESS | S6: drop the 20 s test timeout (the run's per-file timeout is the ceiling). The cross-process point is the test's purpose, so the children stay | n/a |

Excluded: 45 (dead-pid takeover, synchronous). 77/87/97 use injected `runTests` and fixture git via spawnSync with no timeout (time only, result fixed). `asked = Date.now()` in landInTurn is data.

**Shared seam:** S1 (mock setTimeout so RECHECK_MS can't fire) turns the four TIMING-CHECKs (133, 157, 170, 185) into deterministic "woke by the watch" checks with no ms assertion. Note: mock setTimeout also catches the test's own `sleep` (global setTimeout), so replace those sleeps with deferred promises, which 18/31/120 want anyway. churnWatches uses setInterval, so it stays real if only setTimeout is mocked. Size: **S**.

### board/lanes.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 141 | a settle move checks its snapshot under the item file's lock, so a tap written while it waited for the lock stands | `setTimeout(300)` inside the held lock, a stand-in for "moveCard is now waiting on the lock". Under load moveCard may not have reached the lock yet: the result is the same, but the race under test is not exercised. moveCard also fails ELOCKED if the hold passes withFileLock's 10 s deadline | WAIT-ON-TIME (fixed sleep for a state) | S5: a lock-wait signal (an `onWait` hook on withFileLock, or poll for `moveCard` reaching it via an injected `wait`) | no. `hub/locks.mjs:15` takes `timeout` only. `board/store.mjs:2543` moveCard takes no options |

Size: S (needs a small hook in hub/locks.mjs).

### board/main-pull-centre.test.mjs, board/no-sideways-scroll.test.mjs, board/send-bar-snug.test.mjs, board/thread-box-height.test.mjs
Each test renders a page file in headless Chrome via `dumpProbe` (60 s exec timeout, retried once). The page's probe writes as it parses, with no timer.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| main-pull-centre 27 | `${theme} at ${width}px: the refresh icon is centred on main's text` | Chrome exits within 60 s (×2 attempts) | CHROME | S6: drop the 60 s exec timeout and the retry (the run's per-file timeout is the ceiling). Or move the Chrome probes out of the main suite into a browser suite | n/a (`shared/test-helpers.mjs:291`) |
| no-sideways-scroll 32 | `at ${width}px the sidebar and each pane's scrollWidth equals its clientWidth` | same | CHROME | same | n/a |
| send-bar-snug 23 | `at ${width}px (${bodyClass \|\| 'standalone'}) the page ends at Send: main pads only the nav under it` | same | CHROME | same | n/a |
| thread-box-height 22 | `at ${width}px the thread box ${same ? 'matches' : 'is shorter than'} the New task box` | same | CHROME | same | n/a |

Shared seam: one change in `dumpProbe` fixes all four files. Size: S.

### board/merge3.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 22 | many processes running item set on different cards lose none | 12 concurrent CLI children contend on the item file lock. Each waiter's 10 s `performance.now()` deadline (`hub/locks.mjs:18-23`) can fire under load → exit 1 | PROCESS (lock deadline) | Keep the processes, since cross-process locking is the point. Run the lock with no deadline in tests, or inject the lock's clock (S1). Await `close` with no timer (already) | partly: `withFileLock` has a `timeout` option. The CLI exposes no way to set it |

Size: S.

### board/orchestrator-stops.test.mjs
Starts fake run trees (`fakeRun`: a detached node root, nested land, detached suite) and the board CLI as a child (`runAsync`, no timeout). stopRuns/the CLI read **real ps** with a 3 s timeout (hub/live.mjs:45), retried once (headless.mjs:280), and wait up to **grace 5000 ms** for exits (headless.mjs:295–296). The main wait is `until` the run's file signal or process death.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 19 (helper) | fakeRun (used by 44, 64, 73, 91, 113, 142, 161, 271) | spawn detached tree; `until` the pids file is complete (31): the fake writes it (S5 signal, polled 20 ms, 30 s budget) | PROCESS | S5 already; could await a stdout line (S6) and skip the poll | n/a |
| 44 | stopRuns stops each run with every process group under it… | real ps (3 s timeout ×2: a loaded host can fail both, and **stopRuns throws**); `until` land+suite gone (49) | PROCESS / MACHINE | S4: inject the ps table reader into stopRuns (`{ps}` option), or the stallingPs `standIn` style. The process killing stays real | `grace` yes; ps no (env KICKFLIP_PS_TIMEOUT_MS only) |
| 64 | stopRuns asks ps again once when it gives no answer… | PATH ps fails once, then the **real ps** (3 s timeout) must answer, or it rejects. `calls()===2`; `until` gone (70) | PROCESS / MACHINE | S4 (inject ps) | no |
| 73 | stopRuns refuses, stopping nothing, when ps gives no answer twice | fake ps kills itself ×2 | (deterministic) | none | n/a |
| 81 | stopRuns kills what ignores the stop once the grace period ends | awaits 'ignoring' line (S6, already good); `grace: 300` real wait (Date.now + 50 ms polls); awaits exit signal; result fixed | PROCESS (time only, ~300 ms) | S1 (mock Date + setTimeout) if the 300 ms matters; otherwise leave | `grace` yes |
| 91 | the orchestrator's builder stop stops the card's headless builder… | CLI child runs stopRuns (real ps, grace 5 s); `until` all gone (101). `record.stopped.at >= started` (real clock, one direction, fixed) | PROCESS / MACHINE | S4 for ps (a CLI env such as KICKFLIP_PS stand-in, or the stallingPs `standIn` on PATH) | partly (PATH/env only) |
| 113 | builder stop names its run land while the builder is landing… | CLI ×4; processStarts reads real ps lstart (3 s timeout) for the pid-reuse check | PROCESS / MACHINE | S4 / stallingPs `standIn` (it already answers lstart queries) | yes (helper standIn) |
| 142 | land stop on the Merge tap's land stops it and its suite… | CLI; `until` gone (150) | PROCESS / MACHINE | as 91 | partly |
| 161 | land stop on a headless builder's land stops that builder… | CLI ×3; `until` gone (182) | PROCESS / MACHINE | as 91 | partly |
| 186 | a bump orders the land queue… | in process; `until` landQueue()===5 (199) holds on the first poll (every ask queues synchronously); waiters wake by fs.watch or the 5 s RECHECK (time only) | (time only, result fixed) | S1 as land-queue 133 if the 5 s fallback ever shows | n/a |
| 271 | item stall stops the card's run with everything under it… | CLI ×3 (real ps, grace); `until` gone (279) | PROCESS / MACHINE | as 91 | partly |

Excluded: 209 runs the CLI with no timeout over static files (time only, result fixed). 233/250/262 are pure (fixed timestamps, injected `alive`/`launch`). `Date.now() - 60_000` and `+ 10 * 60_000` (94, 135) are data with wide margins.

**Shared seam:** a ps-reader injection for stopRuns/processStarts (S4), or using the existing `stallingPs(dir, standIn)` stand-in on the CLI's PATH, fixes every MACHINE row (44, 64, 91, 113, 142, 161, 271). The killing stays real, which is the point, and the `until`-gone waits become short S6-able exit waits. Size: **S–M**.

### board/prototype-phone.test.mjs
Local `phoneProbe`: an in-process http server on `listen(0)`, Chrome with `--virtual-time-budget=6000` and a 60 s exec timeout, retried once. The in-page probes use `setTimeout(…, 800)`, which runs on Chrome's virtual clock.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 104 | at phone width a take that pairs panels with grid or a non-wrapping flex row stacks them, … | Chrome exits within 60 s. The in-page 800 ms timer runs on virtual time, so wall clock doesn't move it | CHROME, PORT | S6 (no exec timeout) or the browser suite. Could load via `file://` like dumpProbe to drop the server | n/a |
| 114 | at phone width the viewer footer sits on the bottom edge with no gap below it, though the page has a hidden header bar | same | CHROME, PORT | same | n/a |

Size: S.

### board/render-check.test.mjs
Every test runs the board CLI with `KICKFLIP_RENDER_CHECK=on`. The CLI's `board/render-check.mjs` drives real Chrome over CDP. Its waits are all on the wall clock: DevToolsActivePort polled 100×100 ms (line 65), a 3 s settle loop and a 300 ms late-error window (lines 26–27, 123–124), 120 s for a served page's `port` line (line 163), and a 60 s answer loop (line 169).

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 25 | a Chrome that fails to start once is launched again, and the question publishes | real Chrome via CDP and the module's sleeps. The flaky-chrome stand-in exits at once | CHROME | browser suite. Inside it, S1: give render-check.mjs a `sleep`/clock option and await CDP events (`Page.loadEventFired`) instead of the settle window | no (module constants) |
| 33 | a Chrome that fails to start twice is refused naming it, not a raw TypeError | stand-in exits twice. No real Chrome once it fails | PROCESS | S4: inject the Chrome launcher into `checkTakesRender` | no (`board/render-check.mjs:214`) |
| 45 | a prototype question publishes when every take renders, threads included | real Chrome, 3 s settle | CHROME | as row 25 | no |
| 54 | a prototype question is refused, naming each take that throws, logs an error or draws nothing | real Chrome. "logs an error" relies on the 300 ms LATE_MS window, a negative wait for a late error | CHROME, NEGATIVE-SLEEP (in module) | as row 25 | no |
| 72 | a take whose box is hidden at one width is refused naming its class; … | real Chrome | CHROME | as row 25 | no |
| 86 | a served round's question is refused naming each take or state whose page throws, and publishes once they all draw | real Chrome, plus a build-script child serving on `listen(0)` that announces its port. render-check waits up to 120 s for the `port` line and polls answers every 250 ms | CHROME, PROCESS, PORT | as row 25. The port line is already an S5 signal | no |
| 120 | a prototype question publishes when a take draws the sidebar and one draws the hub with its header | real Chrome | CHROME | as row 25 | no |

Shared seam: move the whole file to a browser suite (none of it can run without Chrome). Size: M if render-check.mjs gains a clock and event awaits.

### board/repo.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 12 | hub polling, the server's PR reads and cards follow manifest repo changes and retain the wave fallback | spawnSync of a child that imports `board/server.mjs` with `http.Server.prototype.listen` mocked, and drives `server.emit('request')`. `timeout: 20000` kills it under load. The child also starts the server's fs.watch and 60 s interval until `process.exit` | PROCESS (`timeout:`) | S6 now: drop `timeout: 20000`. Later S3: import `startServer()` in-process. This test is already the importable-server pattern done by hand | no |

Size: S.

### board/server-builds.test.mjs
Each test spawns its own board server with a `--import` setup that counts reads of items.json and logs every fs.watch event, plus an SSE page. The dominant wait is a "quiet window": real sleeps until nothing happens for 800 ms or 2 s, standing in for "every pass has finished".

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 44-46 | withBoard (both tests) | freePorts + spawn + boardListening | PORT, PROCESS | S3 in-process | no |
| 47 | withBoard | until action-pushes.json (first checkActions), 30 s | WAIT-ON-TIME | S3 | no |
| 50-53 | withBoard `ctx.settled` | loops `setTimeout(800)` until the read count stops moving: a fixed delay standing for "all checks finished" | NEGATIVE-SLEEP (quiet window) | S3: the server's own settled() promise; the read counter can stay as the build count | no |
| 64-71,74 | withBoard `ctx.quiet` | until the watch log shows no new name for 2 s (`Date.now() - since >= 2000`), 15 s budget, then settled | NEGATIVE-SLEEP, WAIT-ON-TIME | S2 (no watch: the test calls changed) + S3 | no |
| 72-73 | withBoard probe | writes a probe; untilHeard until the watch reports it (nudge 2 s), 30 s | WAIT-ON-TIME | S2: with changed() called directly, the probe/startup-batch dance is gone | no |
| 79-87 | each change signal builds the board once for every check and the page that reloads on it | appends to a thread; untilHeard until signals>0 and loads===signals; quiet; asserts builds in [signals, signals+1]. The +1 tolerance exists only for late watch events | WAIT-ON-TIME | S2+S3: call changed() once, await settled(), assert exactly 1 signal and 1 build | no |
| 90-110 | a tap builds the board once… writing data/sync.json sends no signal | POST tap; until signal+load, **re-tapping every 5 s** because the watch may drop the events write (`Date.now() - tapped`); quiet; range assertion; 304 check | WAIT-ON-TIME | S2+S3: the tap, then `heard(data,'events.jsonl')` explicitly, then settled; exact counts. The "sync.json sends no signal" half becomes `heard(data,'sync.json')` → no change | no |

**Shared seam.** S2+S3 fixes every row. The `--import` setup shrinks to the read counter, or the server exposes a build count. The fs.watch monkey-patch, probe, nudges, re-taps, quiet windows and the ±1 tolerances all go, and the assertions become exact. Size: M once the server refactor exists. The file is small, but the "late event" reasoning in it should be deleted, not ported.

### board/server-merge.test.mjs
One server child with fake gh on PATH. The taps are synchronous POSTs, and there is no polling.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 26-28 | the Merge tap merges the card in the board server, and a refusal answers the owner… | freePorts + spawn + boardListening | PORT, PROCESS | S3 in-process (or S5: listen on 0 and print the port) | no |
| 33-45 | same | the tap runs fake `gh` processes from PATH (pr view/merge) inside the request; no timeout in the test; mergeCard runs `gh pr view` with none and `gh pr merge` with 120 s (board/store.mjs:3397, :3409), so the result is fixed | PROCESS (time only) | S4: inject a gh runner (optional) | no |

**Shared seam.** Just the in-process server (S3). Size: S. Its result is effectively fixed today; load only changes its time.

### board/server-stale.test.mjs
Every test spawns `server.mjs` as a child with `--import setup`. All but the staging test use a frozen file clock and a 60 s tick shrunk to 20 ms. `listen` is stubbed, so no test here opens a port. Readiness is `boardListening`, a stdout line with no limit. Several tests also start fake `claude` scripts and a push stub. The waits that dominate are `tick()`, a raw 80/120 ms sleep that stands for "some 20 ms minute passes ran", and `until`/`untilHeard`, which wait on the 20 ms tick or on fs.watch.

How load shows up: (a) every `until`/`untilHeard` fails at 5×30 s. (b) Every NEGATIVE-SLEEP (`tick()` then assert nothing happened) passes vacuously when the server has not run a pass yet: under load it stops testing, it does not fail. Some also fail: a pass still running from before can land a write after the sleep. (c) After `advance()`, the clock file changes but the server never watches it. Only the 20 ms real interval notices it, so "after advance, wait" is always WAIT-ON-TIME.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 41/80,101 | a silent builder wakes the session once per silent spell… | server child readiness (`boardListening`), started twice | PROCESS | S3 in-process `startServer()` | no (server.mjs top-level) |
| 41/95-96 | 〃 | sleep 120 ms, then asserts no wake | NEGATIVE-SLEEP | S1+S3: injected `now`, call `minute()`, await `settled()`, assert | no |
| 41/98 | 〃 | `advance(2)`, then `until`: wake by the 20 ms tick, 30 s budget | WAIT-ON-TIME | S1 (`now` option + explicit `minute()`) | no |
| 41/102-104 | 〃 | after restart, sleep 2×120 ms, then asserts still 1 wake | NEGATIVE-SLEEP | S1+S3 | no |
| 41/108 | 〃 | thread write noticed by fs.watch, then `until` | WAIT-ON-TIME (fs.watch) | S2 (call `changed()`), then S3 `settled()` | no |
| 41/110 | 〃 | `advance(31)`, then `until` on the tick | WAIT-ON-TIME | S1 | no |
| 41/114 | 〃 | agent-file write noticed by fs.watch, then `until` | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 41/115-117 | 〃 | `advance(60)`, sleep 120 ms, then asserts no stale wait | NEGATIVE-SLEEP | S1+S3 | no |
| 120/167,189,195 | a held card resumes itself within a minute of its pick-up time… | server child, started 3× | PROCESS | S3 | no |
| 120/181-183 | 〃 | sleep 80 ms, then asserts nothing unblocked and A1 still held | NEGATIVE-SLEEP | S3 `settled()` after start | no |
| 120/190 | 〃 | `until` the due holds resume after restart (start passes and tick) | WAIT-ON-TIME | S1+S3 | no |
| 120/196-198 | 〃 | after restart, sleep 80 ms, then asserts no second unblock | NEGATIVE-SLEEP | S1+S3 | no |
| 202/271,309,324 | with auto implement on the board starts and launches the build… | server child, started 3× | PROCESS | S3 | no |
| 202/255,286 | 〃 | fake `claude` (exits at once) must log its launch, then `until` pull and 2 thread lines | PROCESS + WAIT-ON-TIME | S4 injected launcher recording calls, then `settled()` | no (`launchAgent` agents.mjs:60 spawns; `KICKFLIP_CLAUDE` env only) |
| 202/288 | 〃 | comment: the 20 ms minute check may relaunch the exited fake builder mid-test. The assert is written to tolerate it (`slice(0,2)`) | PROCESS (tick races fake exit) | S1 explicit `minute()` + S4 | no |
| 202/310-312 | 〃 | after restart, sleep 80 ms, then asserts no new pull or refusal line | NEGATIVE-SLEEP | S3 | no |
| 202/316 | 〃 | agent-file write heard via fs.watch, `untilHeard` 30 s | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 202/325 | 〃 | after restart, `until` 3 pulls | WAIT-ON-TIME | S3 | no |
| 202/330-333 | 〃 | usage pause plus `finish('A4')`, sleep 2×80 ms, then asserts no pull | NEGATIVE-SLEEP | S2+S3 | no |
| 202/335 | 〃 | usage file removed (not watched; read by the 20 ms tick), then `until` | WAIT-ON-TIME | S1 `minute()` or S2 | no |
| 343/366-367 | a starting server turns a waiting Implement ask into staging… | server child (no frozen clock), fake `claude` stays to test end | PROCESS | S3+S4 | no |
| 343/368 | 〃 | `until` grill launch logged by fake `claude` | WAIT-ON-TIME + PROCESS | S4 + S3 `settled()` | no |
| 379/435,494 | with auto-triage on, a board sends overnight-triage once a night… | server child, started 2× | PROCESS | S3 | no |
| 379/449-452 | 〃 | clock set, `ask()` write, sleep 80 ms, then asserts no triage (off) | NEGATIVE-SLEEP | S1+S2+S3 | no |
| 379/456 | 〃 | `boardJSON(true)` via fs.watch, then `until` pull | WAIT-ON-TIME (fs.watch) + PROCESS (fake claude) | S2+S3+S4 | no |
| 379/457-458 | 〃 | sleep 80 ms, then asserts no triage in the day | NEGATIVE-SLEEP | S3 | no |
| 379/462 | 〃 | fake builder exits, reviveHeadless relaunches once on a 20 ms tick, then hands back; `until` | PROCESS + WAIT-ON-TIME | S4 (fake exit as an injected launch result) + S1 `minute()` | no (reviveBuilders takes `launch`/`alive`, headless.mjs:316, but server.mjs wires them itself) |
| 379/469-471 | 〃 | clock 02:59, sleep 80 ms, then asserts no triage | NEGATIVE-SLEEP | S1+S3 | no |
| 379/472-475 | 〃 | clock 03:00, sleep 2×80 ms, then asserts no triage (builder runs) | NEGATIVE-SLEEP | S1+S3 | no |
| 379/482 | 〃 | `until` triage (tick and agent-file fs.watch), 30 s | WAIT-ON-TIME | S1+S2+S3 | no |
| 379/490 | 〃 | `untilHeard` server saw the wave write (fs.watch) | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 379/491-496 | 〃 | reply write, sleep 80 ms, restart, sleep 80 ms, then asserts 1 triage | NEGATIVE-SLEEP | S3 | no |
| 379/498-501 | 〃 | clock next night, sleep 2×80 ms, then asserts no second triage | NEGATIVE-SLEEP | S1+S3 | no |
| 379/503-510 | 〃 | `ask()` plus clock 12:00 and 08:00, 4×80 ms sleeps, then asserts none | NEGATIVE-SLEEP | S1+S3 | no |
| 379/512 | 〃 | clock next night, `until` minute check sends | WAIT-ON-TIME | S1 | no |
| 379/518-523 | 〃 | usage pause plus wave write, sleep 2×80 ms, then asserts none | NEGATIVE-SLEEP | S1+S2+S3 | no |
| 379/525 | 〃 | usage removed (tick reads it), `until` | WAIT-ON-TIME | S1 | no |
| 530/585,624 | each card arriving in Todo owes a grill brief… | server child, started 2×; fake `claude` stays; `stallingPs` standIn for ps | PROCESS (+ MACHINE handled: standIn ps still runs `kill -0` on real pids) | S3+S4; injected `starts` for ps | partly: `stallingPs` test-helpers.mjs:178; `agentMayRun({starts})` headless.mjs:258, which server.mjs doesn't pass through |
| 530/599-601 | 〃 | sleep 80 ms, then asserts nothing launched while paused | NEGATIVE-SLEEP | S3 | no |
| 530/604 | 〃 | usage removed (tick), `until` briefs owed and a build pulled | WAIT-ON-TIME | S1+S3 | no |
| 530/606-607 | 〃 | sleep 80 ms, then asserts no grill launched | NEGATIVE-SLEEP | S3 | no |
| 530/616 | 〃 | `writeBrief` heard via fs.watch, `untilHeard` | WAIT-ON-TIME (fs.watch) + PROCESS | S2+S3+S4 | no |
| 530/625-627 | 〃 | after restart, sleep 2×80 ms, then asserts 2 grills | NEGATIVE-SLEEP | S3 | no |
| 530/633,636 | 〃 | owner and agent writes heard via fs.watch, `untilHeard` ×2 | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 530/650-652 | 〃 | B3 done, sleep 2×80 ms, then asserts no regrill | NEGATIVE-SLEEP | S2+S3 | no |
| 658/699,730 | an idle board with auto review on sends pr-review… | server child, started 2× | PROCESS | S3 | no |
| 658/713-716 | 〃 | sleep, usage removed, sleep 80 ms, then asserts none (off) | NEGATIVE-SLEEP | S1+S3 | no |
| 658/717-720 | 〃 | `boardJSON(true)`, sleep 2×80 ms, then asserts none (builder runs) | NEGATIVE-SLEEP | S2+S3 | no |
| 658/721-725 | 〃 | usage pause plus agent done, sleep 2×80 ms, then asserts none | NEGATIVE-SLEEP | S2+S3 | no |
| 658/727 | 〃 | usage removed, `until` review sent | WAIT-ON-TIME | S1 | no |
| 658/731-733 | 〃 | after restart, sleep 2×80 ms, then asserts still 1 | NEGATIVE-SLEEP | S3 | no |
| 658/735 | 〃 | reviews.json heard via fs.watch, `untilHeard` | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 740/774,795 | a question's prototype request still waiting 30 minutes on… | server child, started 2× | PROCESS | S3 | no |
| 740/788-789 | 〃 | sleep 120 ms, then asserts not overdue | NEGATIVE-SLEEP | S1+S3 | no |
| 740/792 | 〃 | `advance(11)`, `until` on tick | WAIT-ON-TIME | S1 | no |
| 740/796-797 | 〃 | after restart, sleep 120 ms, then asserts once | NEGATIVE-SLEEP | S3 | no |
| 802/846,887 | a card that comes to wait on the orchestrator wakes the session… | server child, started 2×; push stub spawned via `KICKFLIP_PUSH_CMD` | PROCESS | S3; S4 injected push | no (env only, store.mjs:260) |
| 802/860 | 〃 | `until` first waits file written | WAIT-ON-TIME | S3 | no |
| 802/865 | 〃 | agent and items writes via fs.watch, `until` wake | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 802/869-870 | 〃 | sleep 120 ms, then asserts still 1 wake | NEGATIVE-SLEEP | S3 | no |
| 802/873-875 | 〃 | `advance(14)`, sleep 120 ms, then asserts no wake | NEGATIVE-SLEEP | S1+S3 | no |
| 802/877 | 〃 | `advance(1)`, `until` tick wake | WAIT-ON-TIME | S1 | no |
| 802/880 | 〃 | `advance(11)`, `until` push stub process wrote its call line | WAIT-ON-TIME + PROCESS | S1 + S4 push | no |
| 802/884 | 〃 | `until` waits file records `pushed` | WAIT-ON-TIME | S3 | no |
| 802/888-891 | 〃 | after restart, sleep 2×120 ms, then asserts no wake or push | NEGATIVE-SLEEP | S1+S3 | no |
| 802/893 | 〃 | `advance(4)`, `until` tick wake | WAIT-ON-TIME | S1 | no |
| 802/898 | 〃 | thread write via fs.watch, `until` picked | WAIT-ON-TIME (fs.watch) | S2+S3 | no |
| 802/899-901 | 〃 | `advance(59)`, sleep 120 ms, then asserts no wake | NEGATIVE-SLEEP | S1+S3 | no |
| 802/903 | 〃 | `advance(1)`, `until` tick wake | WAIT-ON-TIME | S1 | no |
| 802/905-907 | 〃 | sleep 2×120 ms, then asserts no extra wake | NEGATIVE-SLEEP | S1+S3 | no |

Excluded, with the reason:
- `launchingBoard` git `execFileSync` (lines 26-28): fixture with no timeout. It affects time only; the result is fixed.
- Line 264 `Date.now()`: reads the test's own frozen clock to build data, so it is not load-dependent.
- Line 350 `Date.now()`: the staging test's timestamps are passed as data.
- Lines 49, 128, 214, 390, 541, 667, 747, 811: fixed `Date.parse` timestamps.
- The setup's `interval(() => {}, 1000)`: keeps the child alive, with no assertion on it.

Shared seam: one in-process `startServer({site, home, now, launch, push, ps})` → `{changed(), minute(), settled(), close()}` fixes every row in this file together:
- `now` replaces the clock file and `setInterval` patch (S1).
- `minute()` replaces the 20 ms tick.
- `settled()` replaces every `tick()` and every `until`/`untilHeard` (S3).
- A write followed by `changed()` replaces fs.watch (S2).
- `launch` replaces the fake `claude` scripts and `push` replaces the push stub (S4).
- Restart becomes `close()` then `startServer()` on the same files.
Size: L for the server refactor, shared with server.test.mjs. Then M to convert this file: the 8 tests are already structured as advance → wait → assert, and the per-test setup.mjs copies (8 identical blocks) collapse into one helper.

### board/server.test.mjs
One shared board server for the whole file. It runs as a child with a fake Slack (in-process port), fake gh, a push stub, a merge stub, and KICKFLIP_CLAUDE=true, so builders really spawn `true` and exit. Some tests also start their own server, starter server, wait-events watcher, session stand-in, or lock-churn child. The dominant wait is fs.watch hearing a direct write to items.json, polled via boardSees/until (30 s budget, fails at 150 s), plus launchesGone waiting out real launched children before every putWave.

**Fixtures used by many tests**

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 24,40-41 | before() | freePorts then child listens (TOCTOU port); boardListening awaits the "site on" line | PORT, PROCESS | S3: in-process server listening on port 0, or its own `server.emit` | no (top-level `server.listen(port)` :2323) |
| 42 | before() | until action-pushes.json exists: the first checkActions pass after startup, 30 s budget | WAIT-ON-TIME | S3: `await settled()` after start | no |
| 93-100 | `launchesGone` (inside every `putWave`, about 40 call sites) | until every pid in data/agents/*.json is dead: real `true` children launched by earlier tests' taps or checkAuto, 30 s budget | PROCESS, WAIT-ON-TIME | S4: inject the agent launcher so the server records a launch without a process; or S3 if settled() covers launches' exit paths | partial: `launchAgent({bin})` board/agents.mjs:60 takes bin, but the server only gets it via KICKFLIP_CLAUDE env; no in-process launcher option |
| 1723 | `cardsMarkedRead` (used at 1046, 1730, 1766) | until every new card has readAt: the markNewCards pass after a change, 30 s budget | WAIT-ON-TIME | S3 | no |

**Per test**

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 52 | a held card's Merge records the tap… reads merging | boardSees: fs.watch hears putWave, /api/board version moves, 30 s | WAIT-ON-TIME | S2+S3 | no |
| 64 | same | until merges.jsonl ends in a newline: the detached merge-stub child spawned by the tap has run | PROCESS | S4: inject the merge runner; assert the call | env only (KICKFLIP_MERGE_CMD server.mjs:1892) |
| 125,128,133 | the board pushes each new Action needed once… | owner.json written directly, then fs.watch, then changed, then checkActions, then execFile of the push stub; until 1 then 2 push lines, 30 s | WAIT-ON-TIME, PROCESS | S2+S3 (change, await settled) + S4 (inject push runner and record calls in memory) | push: env only (store.mjs:260); no in-process runner |
| 140 | same | until queue.json drops to 2: the answer POST triggers checkActions asynchronously | WAIT-ON-TIME | S3 | no |
| 157 | the owner's last answer on an unstarted card stages it… | putWave only (launchesGone); the rest is synchronous POSTs | PROCESS (via putWave) | S4 (as launchesGone) | as launchesGone |
| 203,226 | an owner answer that picks no take… prototypes again | putWave; untilHeard record.brief: fs.watch hears writeBrief, then checkAuto, then launchBriefs spawns the planner (`true`), with a nudge every 2 s, 30 s | WAIT-ON-TIME, PROCESS | S2+S3+S4 | no |
| 238,264,292,324,356 | prototype request… / re-ask… / reopen… / one owner-answers request… / a Send of answers already recorded… | putWave only | PROCESS (via putWave) | S4 | as launchesGone |
| 414-416,430-433 | a copied starter refuses cross-site writes… | freePorts, then spawns starter/server.mjs; boardListening; awaits 'exit' after kill (no limit) | PORT, PROCESS | S6 is already used for exit. Fix the port with a listen-on-0 server that prints its port (S5), or import the starter in-process | no (starter is a script) |
| 452 | an upload over 20 MB is refused… | none; load changes its time only | — | time only | — |
| 466 | a card with a message marked working… stays in Todo | putWave only | PROCESS (via putWave) | S4 | as launchesGone |
| 481-601 | a Build tap starts the build in the board server… | putWave; taps launch real builders (`true`) and git worktrees. No awaited wait, but leaves children that later putWaves wait out. The git fixture is time only | PROCESS | S4: inject launcher (and S4 for git worktree if wanted) | partial (as launchesGone) |
| 606,643,663,680 | an Implement message stages…; a Prototype, Grill or Visual tap ends…; a thread message sent again…; a hidden thread message… | putWave only | PROCESS (via putWave) | S4 | as launchesGone |
| 700 | a new task is a New T-<n> card… | putWave only | PROCESS (via putWave) | S4 | as launchesGone |
| 721,727 | a Quick build ask carries quick: true… | putWave ×2 | PROCESS (via putWave) | S4 | as launchesGone |
| 745-749,757 | a work card's Hold, Resume and Done apply at once… | `Math.abs(heldUntil - before - 3h) < 60 s` against the real clock; also `Date.now()±` to build refused choices (data, excluded) | TIMING-CHECK(clock) | S1: freeze Date in the server (`--import` setup, as :1822 does, or a `now` option) and assert exact 3 h | no `now` option; Date mock via `--import` works today |
| 776,778 | the events POST answers with the board as the tap left it… | putWave; until C1,C2 on board: fs.watch, 30 s | WAIT-ON-TIME | S2+S3 | no |
| 797,815,821 | a Hold or Done whose item file couldn't be written… | putWave ×3 | PROCESS (via putWave) | S4 | as launchesGone |
| 833 | a Reopen moves a Done card back to Todo… | putWave | PROCESS (via putWave) | S4 | as launchesGone |
| 862-886 | a watcher that just exited on an event still counts as listening… | spawns a session stand-in and bin/wait-events.mjs; `ps -o lstart` exec of the real ps (sync, no timeout); until watcher.json + cursor file, 30 s; awaits watcher 'exit' and session 'exit' (no limit) | PROCESS, MACHINE (ps) | S5: wait-events prints a "watching" line once its cursor is written and the test awaits it (S6). Pass procStart as data instead of reading ps. Exit awaits are already S6 | no ready line in bin/wait-events.mjs (prints only event/plain lines); ps: stallingPs(standIn) helper exists in shared/test-helpers.mjs |
| 890 | the board lists each agent's record on an item… | boardSees around putWave + agent/thread writes | WAIT-ON-TIME | S2+S3 | no |
| 916 | hiding and unhiding many events at once… | none; concurrent POSTs, time only | — | time only | — |
| 934 | the board lists its own title and reviewers from board.json… | putWave; board.json is read per request (:579), so there is no watch race | PROCESS (via putWave) | S4 | as launchesGone |
| 951 | an item's notes are served only from a markdown file… | boardSees around putWave | WAIT-ON-TIME | S2+S3 | no |
| 1040,1044,1046 | the board, a thread and the static files come gzipped… | putWave; until G29 on board: fs.watch, 30 s; cardsMarkedRead | WAIT-ON-TIME | S2+S3 | no |
| 1063-1090 | the stream sends a change, uncompressed, after a write… | until the stream opens (30 s); 6× until a change event after a real write, rename, mkdir and nested write: fs.watch → `changed` debounce 100–500 ms → SSE | WAIT-ON-TIME | Split. The main suite calls `heard(root,name)` directly (S2), covering the rename/new-folder/ignored logic and the SSE line. The real-fs.watch half (watchRecursive/watchEachFolder, :1047 onward) moves to an integration lane outside the main suite (S7-style), since only a real watch tests the OS. | no (`heard` and `changed` are module-private) |
| 1094-1201 | with thousands of folders and lock folders coming and going, the board answers at once… | Own server (freePorts + spawn + boardListening) and lock-churn child. Waits: until stream opens, 2 s budget; until the stream is quiet ≥1.5 s, 4 s budget; drain: own fs.watch + marker every 2 s until quiet 2 s, 14 s budget; a health loop for ≥3 s timing each fetch, with `AbortSignal.timeout(1250)` failing the test and a warn past 250 ms; `setTimeout(1000)` then asserts no change; final until writing every 500 ms, 8 s budget | TIMING-CHECK, NEGATIVE-SLEEP, WAIT-ON-TIME, PROCESS, PORT | Three parts. (a) "answers at once during churn": bench (S7), since it measures latency. (b) "no change for lock folders": S2, a unit on `ignored()`/`heard()` with lock paths asserting `changed` is never called; the 1 s negative sleep goes. (c) "a normal-folder write still signals during churn": S2 for the logic; the real-watch-under-churn version goes to the bench with (a) | no (`ignored` :1010 and `heard` :1022 not exported) |
| 1315 | the settings page's auto-merge toggle… | putWave only | PROCESS (via putWave) | S4 | as launchesGone |
| 1336 | Pause board saves its end in board.json… | `abs(paused_until - Date.now() - 1h) < 60 s` | TIMING-CHECK(clock) | S1 (frozen Date) | Date mock via `--import`; no `now` option |
| 1348 | same | until a usage-resumed event: board.json write → fs.watch → checkAuto (:1531) appends it, or the 60 s tick, 30 s budget | WAIT-ON-TIME | S2+S3 (or the pause POST runs the pass itself and the test awaits the POST) | no |
| 1355-1423 | try forwards only the board route and key over loopback… | freePorts for an in-process fake hub (TOCTOU) and a second board server child on the SAME site as the shared server; boardListening; awaits exit. The code under test aborts the hub fetch at 10 s/30 s (:1389, :1376) | PORT, PROCESS | Inject the hub base URL or fetch (S4); in-process server (S3). The fake hub should listen on 0 and pass its port. Also: two servers watching one site run passes on each other's writes, a hidden interleaving | KICKFLIP_HUB_PORT env only; no fetch option |
| 1431 | the board snapshot reads try.json, main.json and the auto_build setting | boardSees around board.json, putWave, try.json and main.json | WAIT-ON-TIME | S2+S3 | no |
| 1455-1495 | the watcher prints the hub rules, then the board rules… answers a hub ping | spawns wait-events 4×; ownSession runs a real `ps` (sync); until cursor file (30 s) ×4; awaits exit; until /api/working shows the mark (the watcher writes working.json from outside, then the server's fs.watch); until handshake.json ack (the watcher's own fs.watch hears an appended ping) | PROCESS, WAIT-ON-TIME, MACHINE (ps) | S5 (watcher ready line) + S6 (exit). working.json: S2+S3. Ping ack: S5, where the watcher prints its "ping … answered" line and the test awaits that stdout line instead of polling the file. ps: pass procStart as data | no ready line; stallingPs(standIn) exists |
| 1505 | a message in a stalled card's thread clears the orchestrator's stall… | boardSees around putWave | WAIT-ON-TIME | S2+S3 | no |
| 1517,1522,1528 | a wave's triage runs from its wave-triage event until Claude replies… | putWave; until the wave band appears (fs.watch); until triage.running is false after a replies/ file write (fs.watch) | WAIT-ON-TIME | S2+S3 | no |
| 1537-1539 | a later reply to an event is its own entry… | `Date.now() - N` used only to set mtimes (data) | — | excluded: fixed data, ordering only | — |
| 1553,1560,1566 | /api/board names a card's worktree while its folder exists… | boardSees around putWave + agent records; untilHeard (nudge 2 s) until V1 shows its worktree; putWave in finally | WAIT-ON-TIME | S2+S3 | no |
| 1600-1636 | /api/build-targets lists the executable .kickflip/build-* scripts… | git fixture (time only); the code under test runs `git ls-tree` with a 3 s timeout and answers `[]` on timeout (board/build-script.mjs:31), so `{targets:['ios','web']}` fails under load | WAIT-ON-TIME (code timeout) | S4: listBuildTargets takes a `run`, or drop the timeout and let the per-file timeout bound it (S6) | no (`listBuildTargets(repo, ref)` has no options) |
| 1648,1684 | Save on the settings page's reviewers adds and removes in the server… | putWave ×2; Slack DM open and gh user lookup go through `withinWait` 12 s (:760) | PROCESS (via putWave), WAIT-ON-TIME (code timeout) | S4 for putWave; set KICKFLIP_PEOPLE_WAIT_MS high or drop withinWait under test (S6) | env exists (server.mjs:759) |
| 1689-1698 | Board settings' Reviewers lists the workspace's Slack people… | fake Slack over loopback inside `withinWait` 12 s | WAIT-ON-TIME (code timeout) | as above | env exists (:759) |
| 1729,1730 | /api/board carries its change number as its version and ETag… | boardSees around putWave; cardsMarkedRead | WAIT-ON-TIME | S2+S3 | no |
| 1765,1766,1768 | a reload naming the number it holds as since gets a patch… | boardSees ×2; cardsMarkedRead | WAIT-ON-TIME | S2+S3 | no |
| 1801,1806 | a card's question topic in the page's board carries no title… | putWave; until the card and 2 topics are on the board (fs.watch on items.json) | WAIT-ON-TIME | S2+S3 | no |
| 1819-1837 | the board's version depends on its data alone… | spawnSync of an in-process server with mocked Date (S1 already) and mocked listen; `timeout: 20000` kills the child under load | PROCESS | S6: drop `timeout:` (the per-file timeout bounds it), or run in the test process once server.mjs exports `startServer` | Date mock + listen mock already used here |
| 1859-1899 | with Idle notification on, the board pushes "<board> has gone idle"… | spawnSync, `timeout: 60000`. Inside: a hand-rolled until counting real 20 ms sleeps with a nudge every 2 s; `write()` waits until idle.json changes, with a 1.5 s ceiling **swallowed** by `.catch(() => {})`, then sleeps 400 ms as a settle. Under load the tick at :1891 can run before the write is processed, giving the wrong result, not a timeout. Further untils for the first idle check, the push (the push-stub child exits) and the state being forgotten | WAIT-ON-TIME, NEGATIVE-SLEEP (settle sleep), PROCESS | S2+S3: call changed() and await settled(), then tick (S1 is already there); S4 for the push runner; drop `timeout:` | Date mock yes; no changed/settled export; push env only |
| 1918-1940 | data/sync.json keeps the change numbers across a restart… | freePorts ×2, spawns server twice; readiness is `server.stdout.once('data')`, which takes **any** first line (a migration line resolves it before listening; use boardListening at least); until both cards have readAt (30 s); awaits exit on stop | PORT, PROCESS, WAIT-ON-TIME | S3: in-process start/stop twice on one dir with `await settled()`; S5 short-term: boardListening | no |
| 1954,1955,1967,1968,1970 | read marks live on the board… | putWave; until R1/R2 have readAt (fs.watch → markNewCards); putWave; until R2's mark drops; putWave in finally. `first >= start` compares two real ISO times (ordering, kept) | WAIT-ON-TIME | S2+S3 | no |
| 2028,2064 | a Full person's answers, messages, uploads and card taps are recorded… | boardSees around putWave; putWave in finally | WAIT-ON-TIME | S2+S3 | no |

**No wait, no change needed** (tests at these lines): 169, 372, 400, 438, 459, 851, 974, 998, 1203, 1215, 1241, 1571, 1702, 1748, 1791, 1974 (but see hidden races), 2000. Their writes go through POSTs, or through files read on every request (board.json, owner.json via `topicItems`).

**Hidden races (no wait in the test, but load changes the result).** The shared server runs passes in the background: `changed()` passes after every write the watch hears late, and the 60 s tick (:2302) appends orchestrator-waits events and launches. Several tests take an unfiltered count of events.jsonl before and after and assert it's equal:
- :795 (`logged()` at 811, 823)
- :829 (846-848)
- :1974 (`events()` via /_claude/events)
- :2019 (2045-2058)

A late-heard write from the previous test can land a pass's append in that window. I haven't seen it fail; it is plausible from the code. Other tests already filter `orchestrator-waits` for exactly this reason (:209, :243, :269, :297, :323, :375). Seam: S3, awaiting settled() before taking the "before" count, or a server per test. The afterEach at :70 (ask withdrawals) exists only because passes from one test bleed into the next. It has no wait, so there is no row.

**Shared seam.**
- S2+S3 (exported `startServer` returning `{changed/heard, settled(), handle(req,res), stop}`) replaces every boardSees, untilHeard, cardsMarkedRead, action-pushes, triage, readAt and usage-resumed until. That is about 30 call sites, plus the hidden races and the afterEach.
- S4 (an injected launcher and push/merge runner) removes launchesGone, and with it the wait inside about 40 putWave calls, plus the :64 and :128 process waits.
- S5 (a wait-events ready line) fixes :874, :1461 and :1485.
- S1 is already proven at :1822 and covers :749 and :1336.
- The churn test splits into S2 units plus a bench entry (S7).
- The stream test splits into an S2 unit plus a real-watch integration lane.
- Size: L. The server refactor is the bulk, and most rows are then mechanical.

### board/suite-run.test.mjs
Each test runs nodeTests: a real `node --test` child over generated test files, with a run cutoff (`limit`, setTimeout, worktree.mjs:191) that reads **real ps** at the cutoff and kills the group. Node's own `--test-timeout` is also in play. The main waits are the run's wall-clock limits.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 19 | a suite still running at the run cutoff is killed with its whole process group… | `limit: 8000`: the test always takes ≥8 s. At the cutoff the **real ps** lists the group, and `hung.files` is every file still running. On a loaded host `a-quick.test.mjs` may still be running at 8 s, so the message names it too and the `first` assert fails (**load decides the result**); `ok N - quick` may also be missing. Then `until` the grandchild dies (50) | PROCESS / MACHINE / WAIT-ON-TIME | S5/S1: make the cutoff a trigger, not a duration. E.g. nodeTests takes `cutoff` (a promise) next to `limit`, and the test resolves it once the hang file has written its pid **and** the quick file's 'ok' line is in. Or mock setTimeout (S1) and tick the cutoff after those two signals, since `until` stays real (checked on Node 26). The real ps stays: the "processes left" log is what's tested | `limit` yes (a duration); trigger no |
| 53 | a test that runs past the per-test limit fails as timed out, and the rest of the suite still runs | `testLimit: 2000` vs a 4 s test. On Node 22 the limit covers file start, so under load `after.test.mjs` can also time out (pass≠1); the comment admits it | TIMING-CHECK-ish (asserts node's own timer fired) → **rewrite deterministic**. Make `slow` never resolve (`new Promise(() => {})`) so the timeout fires whatever the load. Assert the wiring as data: `testArgs(2000, …)` contains `--test-timeout=2000` (pure). Check failure parsing on a canned TAP sample (`tapFailures`). The run itself is only node's feature: don't bench it, delete the real-time part | S8 for the timed run + pure checks | testArgs yes (exported, worktree.mjs:169); tapFailures not exported |
| 69 | a suite that passes resolves with its counts and saves no log | spawns node --test (default limits 15 min / 5 min) | PROCESS (time only) | none needed | n/a |
| 78 | a child a passing test left running is killed as the run exits | node --test; `until` the leaked child dies (94), killed synchronously on exit | PROCESS | S6: the kill is synchronous in the exit handler, so assert at once after `await` (zombie reaping aside) or keep the `until` (it passes on the first poll) | n/a |
| 97 | a suite's tests get a failing tailscale stub… | node --test | PROCESS (time only) | none needed | n/a |

Excluded: 109 reads `os.availableParallelism()` (cores, not load) and compares it with the same formula, so the result is fixed.

**Shared seam:** a cutoff trigger on nodeTests (a promise option, or S1 mock timers) fixes 19. 53 becomes pure. Size: **S**.

### board/ticket-paths.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 175 | the board server's Run review route and arch file file their cards as tasks | spawned `server.mjs` on a `freePorts` port, `boardListening`. Request and response only, no fs.watch wait | PROCESS, PORT | S3 | no |

Size: S once S3 exists.

### board/ui.test.mjs
Starts nothing. It loads the UI scripts into a vm context and passes the real `setTimeout` (line 6), but every async test injects `fetch`/`sleep`. The dominant dependence is the real clock inside the code under test.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 2519 | a busy host reads busy on the Hub row and the logo dot, not on a board or the header, a pause first, and Health has a Machine row | `since: Date.now() - 59_000` (2527). The code reads the real clock: `busyMinutes`/`hubBusy` (ui-sidebar.js:208-210) floor to whole minutes. One second of delay between 2527 and the render flips "busy under a minute reads as not busy" (2528-2529). | CLOCK | S1: fixed `now`, passed in | Partial. `sidebar(data,{now})` (ui-sidebar.js:223), `busyMinutes`/`hubBusy` take `now`, but `hubDot(data,{offline,update})` (ui-sidebar.js:215) calls `hubBusy(data)` with no `now`. Add it. |
| group (≈70 tests; tightest: 204, 341, 1508, 1534, 1551, 1562, 1957, 2046, 2383, 2414, 2433) | e.g. "the header reads the time since the last change signal…", "a builder line shows the progress and its age…", "a card idle on the orchestrator reads waiting for orchestrator with how long…" | Data built as `ago(h)`, `minutes(n)` or `new Date()` from the real clock (14, 343, 1509, 1535, 1552…). The renderers read the real clock again: `ago`/`since`/`lasted` (ui.js:8-21), `shortSince` (ui-header.js:29), ctx minutes (ui-sidebar.js:148), review days (ui-cards.js:51). `Math.round` leaves ≥ 30 s slack per assertion (e.g. '14m', '4m', '1 min'; 'now' has 60 s), so these fail only after a ≥ 30 s stall. | CLOCK | S1: give each renderer a `now`, and have the tests build data from a fixed `now` (as 460 already does) | Partial. `etaLine`/`cardTime` (ui.js:25,31), `heldUntilWords`/`holdPicker` (ui-cards.js:273,341), `failedStart`/`startCaption`/`sidebar` (ui-sidebar.js:161,178,223) take `now`. `ago`/`since`/`lasted`/`shortSince`/`statusLine`/`githubLine`/`builderLine`/`workLines` don't. |
| 1699 | a card's last line is the time its lane sorts by, then its hold… | The test's `now = new Date()` (1715) builds hold dates by day. `workLines` calls `heldUntilWords` with its own `new Date()`, so a midnight crossing between the two flips "today"/"tomorrow". | CLOCK | S1 | Partial. `heldUntilWords(iso, now)` exists (ui-cards.js:273); `workLines(it,{unread})` (ui-cards.js:413) doesn't pass it on. |

Excluded:
- 6: real `setTimeout` given to the context. No test waits on it.
- 1178, 1222, 1261: `fetchJSON` takes injected `fetch`/`sleep` (ui.js:427), so the backoff is deterministic.
- 527: `performance` is a stub.
- 460 and 2384-2436 `resets_at = Date.now()+1h`: an hour of slack. 460 uses a fixed `now`.
- `new Date().toISOString()` used only as an arbitrary timestamp in thread and question data (750-2909): rendered as a time of day, not compared.

Shared seam: one S1 pass ("every renderer takes `now`, and ui.test fixes one `NOW` constant") fixes every row together. Size: M (many call sites, mechanical).

### board/view.test.mjs
`fakePage` fakes `setTimeout`/`setInterval`/`performance`/`requestAnimationFrame` (view.test:76-128), driven by `runTimers`/`runIntervals`/`advance`. `tick` is `setImmediate` (2061): an event-loop turn with no wall clock. The dominant wait is `until` on fake-fetch and fake-IndexedDB promise chains. One test spawns the real hub.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 1268 | a board view keeps the board and its change number in IndexedDB, and the next mount paints that copy live… | `until` ×4 (1279, 1282, 1292, 1303) on the fake fetch and `memoryIndexedDB` microtask chain (30 s budget, 150 s fail) | WAIT-ON-TIME | S6: await the operation's own promise, or a wall-clock-free `drain()` (loop `await setImmediate` until the fake fetch/IDB queues are empty) | Partial. `view.B.loadBoard()` returns a promise (used at 1333, 1403). The copy save on unmount has none, so add `B.saved` or use the drain. |
| 1309 | with no copy to show, a board out of reach shows the landing for its state, retries every 5 s… | `until` 1320, 1328. The 5 s retry is already a fake interval (`runIntervals(5000)`). | WAIT-ON-TIME | S6 (`await B.loadBoard()` / drain) | yes (`B.loadBoard`) |
| 1340 | a board that throws while drawing shows the landing with the error… | `until` 1356 | WAIT-ON-TIME | S6 | yes |
| 1377 | out of reach with nothing on screen, the board paints the copy another build saved… | `until` 1388, 1397, then one `setImmediate` (1398) | WAIT-ON-TIME | S6 | yes |
| 1412 | out of reach, Notes show their last answer here under its copy line… | `until` 1425, 1431, 1435 (the notes page's fetch, IDB save and copy paint) | WAIT-ON-TIME | S6: drain | No. The notes view exposes no load promise. |
| 1440 | out of reach, Waiting on you paints the board's copy… | `until` 1457 | WAIT-ON-TIME | S6: drain | no |
| 1467 | out of reach, Board Settings shows each part's last answer here… | `until` 1474, 1486, 1494 (with `setImmediate` at 1491) | WAIT-ON-TIME | S6: drain | no |
| 1498 | where IndexedDB refuses or is missing, the board view loads the whole board… | `until` 1507 | WAIT-ON-TIME | S6 | yes |
| 1705 | the shell uses the inline or fetched boot code, adopts the first live code… | `until` 1739 ("the header code check before paint") | WAIT-ON-TIME | S6: drain | no |
| 1796 | an open shell shows new hub code before the next Hub paint and reloads only on a tap | Real `hub.mjs` child on a `freePorts()` port (1812-1825), started under a 30 s `setTimeout` reject guard (1820) and test `{timeout:120000}`. The test also opens a real HTTP SSE stream and runs `until` 1884 (first paint and a sidebar SSE event) and `until` 1898 (next paint after rewriting hub-code.json). The hub's 15 s tick reads real load (finding 2). | PROCESS, PORT | Split it. The shell half: an in-process stub http server (like hub/shell.test's `fakeBoard`) serving sidebar.json, the `x-hub-code` header and SSE, plus S6 (await the SSE event). The hub half ("sidebar has no upgrade", `/_hub/upgrade` 404, code hash served) belongs with the hub's in-process `startHub` (S3). Drop the 30 s guard and await `'hub on'` with no timer (S6). | No (hub not importable) |
| 4089 | Hold opens a sheet of the shared duration picker in place of a confirm… | `words(ms)` (4111) recomputes `heldUntilWords(new Date(Date.now()+ms))` after the sheet opened with its own `new Date()`. A minute rollover in between makes the aria-labels differ. | CLOCK | S1: freeze the page's clock (`win.Date` in `fakePage`), or read the `now` the sheet used | Partial. `holdPicker(key, choices, now)` (ui-cards.js:341) and `heldUntilWords(iso, now)` (273) take `now`; the page's sheet open passes none. |

Excluded:
- `tick` (2061 and ≈150 uses): event-loop turns, no clock.
- 93-96: fake timers.
- 1554: `setTimeout: () => 0` stub.
- 2378-2422, 2654-2655, 2697-2698, 5795-5796: wrap the fake timers.
- 605: `Date.now()+3h` "until" matched by `[^<]+`.
- 6280: refused `ago(10_000)`/`ago(4*60_000)` rendered as relative words with ≥ 30 s slack (CLOCK, low; same fix as ui.test's group).
- 4090: `Date.now()+2 days` hold, compared loosely.

Shared seam: one `drain()` helper (or `settled()` promises on the views) fixes 1268-1705 together, size S. Row 1796 is M and rides on the hub refactor. Row 4089 is S.

### hooks-plugin/hooks/board-messages.test.mjs
spawnSync of the hook. Its age words come from the real clock.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 13 | the PostToolUse hook shows the owner's new thread messages, asks and ask edits to the board's session once each, … | fixture times `ago(3)`/`ago(0)` against the hook's own `Date.now()` (`board-messages.mjs:50`). It expects "3 min ago" and "just now", which flip if a spawn takes ≥60 s from when the fixture was written. Line 73 `marks.e3 >= before` is a safe bracket | WAIT-ON-TIME (60 s margin on the real clock) | S1: freeze Date in the hook child (`--import` setup, as server tests do), or let the hook read `now` from the input/env | partly: `shownOn(board, session, now)` (`board-messages.mjs:24`) takes now. The script's top level reads `Date.now()` |

Size: S.

### hooks-plugin/hooks/watcher-stop.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 14 | the Stop hook blocks once while a board the session owns has no live watcher, … | a live sleeper (`untilTestEnds`) as the watcher pid. The hook's `watcherRunning` asks the real `ps` for its command line (3 s timeout, `hub/live.mjs:44`). A timed-out ps gives `?? true`, so the asserted results don't change. Reads the real process table | MACHINE (result fixed, time varies) | S4: inject `alive`/`commandOf` into `watcherRunning` | partly: `hub/boards.mjs:234` takes `now` and `grace`, but not ps |
| 45 | the Stop hook also blocks once while a message on a board the session owns reads Working on it with no answer, … | `freePorts` then `listen(port)`, which races; use `listen(0)`. The hook's fetch of `/api/working` aborts at 3 s (`watcher-stop.mjs:14`), and an abort means "no block", so the test fails | PORT, PROCESS | S4: the hook as an exported function with an injected fetch. At least `listen(0)` | no |

Size: S.

### hub/awake.test.mjs
Spawns `hub/hub.mjs` on a `freePorts` port with a fake `caffeinate` on PATH. The fake polls `kill -0` every 0.1 s.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 21 | the hub runs caffeinate -s while Keep awake is on, stops it when turned off, starts it again after a restart, … | hub child and port (readiness by "hub on", no timer). Hub restarted 4 times | PROCESS, PORT | S4: inject spawn into `caffeinate()` and drive the keep-awake setting and startup in-process | no. `hub/awake.mjs:24` `caffeinate({log, platform})` spawns `'caffeinate'` itself (line 43) |
| 67 (in 21) | same | `until` the fake caffeinate has logged its Nth start (30 s budget) | WAIT-ON-TIME | S4: the injected spawn records the call synchronously | no |
| 72 (in 21) | same | `until` the fake logs `stop <pid>` after SIGTERM | WAIT-ON-TIME | S4: the injected child's `kill` records it | no |
| 59 (in 21, `t.after`) | same | `until` every fake caffeinate has exited (the 0.1 s `kill -0` loop notices the hub is gone) | WAIT-ON-TIME | S4 (no real children to wait for) | no |
| 113 (in 21) | same | `setTimeout(300)` then asserts no 5th caffeinate started for a timed keep_awake_until | NEGATIVE-SLEEP | S4: once startup has run in-process, assert the injected spawn was never called. No wait needed | no |

Shared seam: S4 on `caffeinate()` plus an in-process hub start fixes every row. Size: M (hub.mjs is a top-level script like server.mjs).

### hub/boards.test.mjs
`before()` (233) spawns the real hub. The hub spawns real `board/server.mjs` for orch and shop (the plain site is `/bin/sleep 600`) and runs a fake push device. Ports come from `freePorts(17)` (41). `stallingPs` answers ps through `sh` under live.mjs's 3 s timeout. The dominant wait is `until` on hub HTTP, racing the hub's own 15 s and 60 s timers.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 41 / 233 (before) | (file setup) | `freePorts(17)` reserves ports, then releases them before the hub and boards bind. Another suite can take one; test 345 carries a diagnostic for exactly that. Hub readiness is awaited by the "hub on" line (S6, no limit). Then `until` ×2 (254) for orch/shop `/_claude/health`: the hub's 2 s reconcile spawns them and probes them. | PORT, PROCESS | S3: in-process `startHub` listening on 0 and reporting its port; boards spawned through injected `run` (S4) or in-process `startServer` | No (hub.mjs:241 env port only; boards get `PORT` from the manifest, hub.mjs:301) |
| 233-255 (file) | every test on the shared hub | The hub's 15 s tick reads real load (finding 2), runs a session check that rewrites resume-state.json (the comment at 652-653 works around it) and may push `resume-shop` (the filter at 663) | MACHINE, WAIT-ON-TIME | S4: inject `readMachine`; `ticks:false` with the test calling `tick()` | No (hub.mjs:600) |
| 273 (after) | (teardown) | Sleeps 200 ms before `rmSync`, standing for "a board server may still be flushing" | NEGATIVE-SLEEP (teardown) | Delete. The hub exits only after its children are gone or SIGKILLed (hub.mjs:613-627), and `rmSync` already retries (`maxRetries:20`). Or S6: await the children's exit. | n/a |
| 76 | an event for a board that is down is appended directly, and one a board took without answering in time is not written twice | `appendEvent(..., {timeout:300})` against a server that never answers (90) asserts "didn't answer within 0.3 s". Time only; the result is fixed. Also `downPort` from `freePorts(1)` (80): if something binds it, the append goes over HTTP and the result changes. | WAIT-ON-TIME, PORT | S1: abort from the test, via an `appendEvent` `signal` option. Use port 1 for "down", as line 86 already does. | Partial. `appendEvent` takes `{timeout}` (boards.mjs:196,201), not a signal. |
| 300 | closing a board through the hub requires JSON, same-origin access and its exact name… | `until` health of a new board server the hub spawns on `closePort` (313; 2 s reconcile), and `until` its pid file goes after close (334) | PROCESS, PORT | S3 (`startHub` + `reconcile()`/`settled()`) + S4 (injected spawn) | no |
| 383 | one check polls each open PR on either board once, writes both checked.json, and pushes once for the board not listening | A manual `/_hub/poll` asserts exactly one query (`queried`) and `pushes()` equal to `[deaf-shop]`. **Race:** the hub's own first poll fires at start + 60 s (hub.mjs:435,439,600). If before() and tests 278-345 take over 60 s under load, the hub polls first: `queried` holds two entries and `r.deaf.pushed` is `[]`, so the test fails. | WAIT-ON-TIME (code's 60 s timer) | S1: the hub takes an injected clock and no background ticks (`ticks:false`); the test drives `tick()`/`poll()` | No (`polls.firstAt` uses `Date.now()`, hub.mjs:439) |
| 396 | a GitHub change goes to every board showing that PR, and pushes alone never wake sessions to build | Same background-poll race. It counts events exactly and asserts `device.received.length === 1`. | WAIT-ON-TIME | S1 (as 383) | no |
| 534 | a board whose repo fetch fails gets a Repo fetch link that settles, reads degraded on Health… | `until` ×5: 551 (poll until the failed fetch reaches the board), 554 (rewrites link-faults.json each turn until the hub's own write stops undoing it and the link reads broken), 558, 569, 572; plus `until` health in `finally` (577). Spawns `bin/wait-events.mjs` (564) and awaits its close (no limit). | WAIT-ON-TIME, PROCESS | S1 for the grace: `linksOf(board, {now, faults})` already takes them (boards.mjs:530; test 145 does it in-process). The board/hub propagation goes to S3. | Partial (`linksOf` yes; hub no) |
| 581 | the daily wake reaches both boards | `until` check-github events on both boards plus wake-state.json, i.e. waits for the hub's 15 s tick to run `runWakes` (hub.mjs:514,605) | WAIT-ON-TIME (server 15 s tick) | S1: call `sendWakes({now, settings, manifest})` in-process | yes (github.mjs:386) |
| 589 | listening again ends the outage, a watcher whose session is not running does not, and the next one pushes again | `ps.stall(true)`, then `/_hub/poll`. The hub's live.mjs waits out its 3 s ps timeout against a stand-in that sleeps 10 s. Also spawns sleepers. | MACHINE, PROCESS | S4: `checkListening({manifest, running:null})` in-process, as sessions.test:741 already does | yes (boards.mjs:339 `running`) |
| 610 | the sidebar reads a board's listening fresh: a watcher starting or exiting shows on the very next read… | Hub sidebar reads with sleeper/liveSession processes; liveness goes through the stand-in ps (3 s cap) | PROCESS, MACHINE | S4: `listenState(board, {running, wakes})` in-process | yes (boards.mjs:275) |
| 631 | a board whose stopped session the hub can wake is asleep, then waking once the hub resumed it… | In-process `listenState`/`checkListening` without `running`, so each call spawns the stand-in ps (3 s cap) (638-657). Awaits the liveSession child's `exit` (646; S6, fine). | MACHINE | S4: pass `running` (a Map) | yes (boards.mjs:275,339) |
| 679 | joining a board polls at once, so the new board's GitHub link passes… | `kickflip join` runs `hubStatus()` with a 1.5 s cap (finding 3); `poll === 'reached this board'` fails on a slow hub. Also a Date.now window (686: `created` between `before-1000` and now). That window is load-safe since it only widens, but it is clock arithmetic in an assertion. | PORT, TIMING-CHECK | S6: drop the 1.5 s abort, or S4. For 686: **delete** the window and assert `created` parses and survives the rejoin (689). | no |
| 693 | New board validates through HTTP, reports a failed clone and preserves repo and branch… | `until` ×3: 751 (the hub's async git-clone child fails), 771 (retry fails again with a new askedAt), 800 (every in-flight clone settles, so nothing outlives the test). CLI join (1.5 s cap). `ago(16)` against the 15-minute start limit read with the hub's real clock (≥ 1 min slack). | PROCESS, WAIT-ON-TIME | S4: inject the clone runner (`runRepo`, spawn at repos.mjs:77) into the new-board flow. S3 `settled()` for the clone job. | Partial (`runRepo` is a module function, not passed to the hub) |
| 804 | a board session's permission prompt pushes to the hub page, counts in that board's needs and the badge, and Always allow reaches its hook… | Spawns permission-hook.mjs (5 s POST cap, 25 s long-poll; finding 4). `until` prompt in Orch needs (815) and `until` push at the fake device (824). | PROCESS, WAIT-ON-TIME | S6: the fake device resolves a promise per push (await `device.next(tag)`). The hook's long-poll via S4 (preload fake fetch, as prompts.test:299). The needs half via S3. | Partial (`--import` preload works on the hook today) |
| 870 | object property names work as page routes and as new boards through HTTP and the CLI | CLI join (1.5 s cap), `until` health of a new board server (904), `until` down_since recorded (918), which waits for the hub's 15 s session check | WAIT-ON-TIME, PROCESS | S1/S4: `checkSessions({manifest, now, live})` in-process for the down_since half | yes (sessions.mjs:409) |
| 959 | a starting hub makes the hub board a local board of its own folder once… | Spawns a second hub 3× and awaits `'hub on'` then exit (S6 already, no limit); real git init (fixture) | PROCESS | S4: call `migrateHubBoard({run, clone})` in-process | yes (board-repo.mjs:78) |
| 996 | stopping the hub stops every site it started, one that ignores SIGTERM and one that joined just before, and starts none | `until` the stubborn site logs ready (1004). Then the hub's fixed 5 s KILL_AFTER escalation (hub.mjs:276,621-626), then `until` machine-wide `ps -axo` shows none (1012; reads the real process table). | PROCESS, MACHINE | Keep as the file's one process-level smoke test. Inject KILL_AFTER (S1). After the awaited hub exit (S6), check the known pids from `run/<route>.pid` with `kill(pid,0)` instead of polling a machine-wide ps. | no |

Time only, result fixed:
- 62, 117, 145, 159, 174, 187: in-process, fixed `now`.
- 278, 345, 427, 448, 454, 470, 511, 927, 944, 950: one HTTP round trip each to the already-up hub. They inherit the file-level PORT and MACHINE rows. 470's `usage.at = now` has a ≥ minutes slack.
- 661: a CLI handshake to the hub; it asserts `handshakePushes` excluding the tick's `resume-shop` (the file-level tick row).
- 835: spawns permission-denied-hook.mjs and awaits close with no limit.

Excluded: `ago()` as data (34, 45, 238, 593, 616) with minutes of slack against the hub's thresholds; `lsof`/`ps` at 362-363, which run only on failure for the diagnostic.

Shared seam: S3 for the hub (`startHub` in-process, `ticks:false`, injected `readMachine`/`probe`/`run`, with `reconcile()`/`tick()`/`settled()`) fixes before/after and rows 300, 383, 396, 534, 693, 804 and 870. S4 with already-existing injection points (`running`, `now`, `sendWakes`, `migrateHubBoard`, `checkSessions`) fixes 581, 589, 610, 631, 870 (half) and 959 now, with no hub refactor: size S. The rest is L (it rides on the hub refactor).

### hub/close-board.test.mjs
In-process with injected `live`/`run`, apart from one CLI test and one watcher child.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 113 | closed routes are reserved against new boards, starts and joins, and CLI close validates the title | execFileSync of the CLI. `reopen` runs a fake claude via `runClaude` (60 s kill timer plus a 300 ms settle after exit, `hub/sessions.mjs:159-175`) | PROCESS (product timeout, never binds in practice) | S4: the CLI path already uses `run`. Only the CLI wrapper spawns | yes in the library (`reopenBoard({run})`) |
| 212 | failed reopen keeps the session lock until rollback so a queued resume cannot launch into a closed board | `setTimeout(250)` then asserts `launches === 0` while the manifest lock is held. Under load it passes without testing anything | NEGATIVE-SLEEP | S5: a lock-wait signal from withFileLock (the queued resume is waiting), then assert. Or S1 mock timers if the lock takes an injected clock | no (`hub/locks.mjs:15`: `performance.now` and `setTimeout`, no hook) |
| 249 | reopen rewinds to the cursor saved before stopping even if the old watcher advanced while closed | spawns `bin/wait-events.mjs`, `setTimeout` 30 s reject on close | PROCESS | S6: await `close` with no timer. The watcher exits on the saved event | n/a |

Excluded: line 131 `timeout: 8000` is asserted data (the runner's options). Line 136's single `setImmediate` is a one-tick check whose result doesn't depend on load. The session lock in 136 (withFileLock, 90 s deadline) only affects time.
Size: S.

### hub/gate.test.mjs
Each test spawns a real **hub.mjs** on a free port (freePorts listen-and-close: PORT race) with a fake tailscale, and awaits its 'hub on' line (S6, no limit). Board tests also have the hub spawn a stand-in board server on a second free port. The main wait is hand-rolled `Date.now()` deadline loops (15 s / 5 s, hard fail at the deadline, not 5x) over hub-internal real timers: ownerGate's **retryMs 5000** (board/on-host.mjs:58, used through the module singleton `hubGate` at :83) and hub.mjs's **2 s `endUnshared` interval** (hub.mjs:1394). ownerGate already takes `{now, retryMs}`, but hub.mjs can't pass them (top-level script, singleton).

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 25 (helper) | startHub (all tests) | spawn hub.mjs + 'hub on' line; freePorts race; t.after kill + await exit; hub's own 2 s reconcile and 15 s tick run during the test | PROCESS / PORT | in-process `startHub({gate, port: 0})` from hub.mjs (S3 for the hub), shared with try.test.mjs:1218 | no |
| 90 | every hub path answers only the owner… | no waits after start; `statusAsks()===1` holds because a success is cached | PORT / PROCESS (time only) | as helper | ownerGate yes, hub no |
| 126 | while tailscale can't name the owner, signed-in devices get a page saying so… | **136: `statusAsks()===1` "a failed read is not retried at once" holds only if under 5 s pass** between the first failed read and this line (retryMs 5000). On a loaded host it can be 2 → **load decides the result**. Then 140–143: a hand-rolled 15 s deadline polling every 250 ms waits out the **real 5 s retry** | WAIT-ON-TIME / NEGATIVE (time-window) / PORT | S1: an injected `now` on the gate (ownerGate takes `{now, retryMs}`), moved past retryMs by the test. Needs the hub to take the gate (in-process hub) or an env such as KICKFLIP_GATE_RETRY_MS. Or test ownerGate directly as a unit with `now`, and keep one hub test for the wiring | ownerGate yes (on-host.mjs:58); hub no |
| 146 | a board shared with a login lets that person read the shell… | 149–150: 15 s deadline loop, every 100 ms, until the hub-spawned stand-in board answers (no assert at the deadline: later asserts fail instead) | PROCESS / PORT / WAIT-ON-TIME | S5: the stand-in prints/writes ready, and the hub's site-up state is awaited. In process, inject the site starter (S4) | no |
| 205 | a shared person's path is checked and forwarded as one parse… | same 15 s stand-in loop (207–208) | PROCESS / PORT / WAIT-ON-TIME | as 146 | no |
| 226 | removing a share ends that person's open hub stream… | same stand-in loop (228–229); `open()` arms **setTimeout(reject, 5000)** (240), which keeps the loop alive 5 s and rejects if the stream answers late; **245: sleep 300, then asserts their stream has NOT ended**; 251–252: 5 s deadline, every 50 ms, for the stream to end (the POST's `res.on('finish', endUnshared)`, hub.mjs:1492, or the 2 s interval) | NEGATIVE-SLEEP / WAIT-ON-TIME / PORT | 245: nothing ends a stream except endUnshared, so assert right after both streams open, or after one forced `endUnshared()` call in process. 251: await the response's 'close' (S6) with no deadline. 240: drop the 5 s reject timer (S6) | no |
| 258 | a Full person's events and uploads reach the board named as them… | stand-in loop (260–261); 5 s reject timer (289); board.json edit picked up only by the **real 2 s endUnshared interval** (hub.mjs:1394), awaited by a 5 s deadline loop (293–294): 2.5x headroom, hard fail | WAIT-ON-TIME / PORT | S1 (mock or inject the 2 s interval), or S2: call `endUnshared()` directly in an in-process hub; then await 'close' (S6) | no |

Excluded: `sharing.people[0].at` regex (187) is shape only.

**Shared seam:** an importable in-process hub (`startHub({port: 0, gate, sites})` with `endUnshared` exposed) fixes all of it. A port of 0 removes the race, the injected `ownerGate({now, retryMs})` gives S1 for 126, and direct `endUnshared()` calls give S2 for 226/258. The stand-in board still needs S5 readiness. The same refactor serves try.test.mjs:1218. Short of the refactor: S6 'close' awaits replace the 5 s loops and timers, which is quick. Size: **L** with the hub refactor, **S** for the S6-only clean-up (126 stays load-dependent then).

### hub/github.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 541 | the poll runs a landed card's owner-step check, closing it once it passes and leaving a card whose code hasn't landed alone | in-process http server on `listen(0)`. The url check's fetch aborts at 20 s (`shared/owner-check.mjs:87`) | PORT | S4: pass `fetchImpl` through the poll | partly: `runCheck({…}, {fetchImpl})` (`shared/owner-check.mjs:113`). The board poll doesn't pass one |

Size: S.

### hub/linear.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 130 | the hub saves the Linear key from its settings form, … | spawned hub on a `freePorts` port ("hub on", no timer). The fake Linear runs on a loopback port. Hub→Linear fetch aborts at 15 s (`hub/linear.mjs:39`) | PROCESS, PORT | S3 (in-process hub, port 0) + S4 (`linearClient({fetch})` exists) | partly: `linearClient(key, {fetch})` is injectable. hub.mjs is not importable |
| 182 | a board on Linear falls back to no ticket source when the hub starts with no Linear key, … | same | PROCESS, PORT | same | same |

Shared seam: an importable hub (S3). Size: M (shared with every hub-spawning test).

### hub/live.test.mjs
Sleeper children signal readiness over IPC, which is already S5. A shell stand-in `ps` (`stallingPs`) runs through `execFileSync` with the module's 3 s timeout.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 37 | liveSessions reads the session records and checks each pid and its start time with ps | the stand-in ps must answer within `ps()`'s 3 s timeout (`hub/live.mjs:44-47`). Under load a slow `sh` start returns null and the test fails | PROCESS (production timeout) | S4: inject `ps` into `liveSessions`/`processStarts`/`parentOf` | no (module-level `ps`) |
| 69 | a ps that times out leaves every liveness unknown, … `{timeout: 60000}` | sets `KICKFLIP_PS_TIMEOUT_MS=200` and waits out a real 200 ms timeout 3–4 times. The first call ("answers before it stalls") also needs <3 s. Has a per-test timeout | WAIT-ON-TIME, PROCESS | S4: an injected ps that returns null stands for the stall. No real timeout | no |
| 84 | parentOf reads a running process's parent with ps, and null once it has exited | stand-in ps under the 3 s timeout. Awaits the child's `exit` (S6, fine) | PROCESS | S4 | no |

Shared seam: one `ps` option fixes all three. Size: S.

### hub/locks.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 12 | a lock whose holder process is gone is taken at once, not after staleAfter | asserts `performance.now() - started < 1000` | TIMING-CHECK | **delete** the elapsed assertion. Taken "at once" is shown by the lock being taken with `staleAfter` left at its default (30 s) while `timeout` is set below it. Or count polls with an injected wait, which is deterministic. Speed isn't what this test is about | n/a |
| 23 | a lock held by a live process still makes a waiter wait, then fail | waits out a real 300 ms deadline (`timeout: 300`, polled every 100 ms) | WAIT-ON-TIME | S1: inject the clock/wait into withFileLock | no (`hub/locks.mjs:15-24` uses `performance.now` and `setTimeout`; node's mock timers don't mock `performance.now`) |
| 32 | a lock with no pid recorded still goes stale by age | `timeout: 2000` as the ceiling. The stale lock is removed on the first pass. `Date.now() - 60_000` mtime is data | WAIT-ON-TIME (ceiling only) | S1 as above | no |

Size: S (add `{now, wait}` options to withFileLock).

### hub/new-board.test.mjs
Mostly in-process with injected `run`/`live`/`repos`.

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 148 | a fresh clone's progress stays in hub memory as one percent, reaching the sidebar at most once a second, … | line 160 polls `clonePercent` up to 200×5 ms = **1 s hard cap, no 5× slack**, then asserts 45. The throttle is `Date.now() - sent < 1000` (`hub/new-board.mjs:86`). The stand-in feeds every line synchronously, so the throttle only flips if that synchronous loop is stalled for over 1 s | WAIT-ON-TIME | S5: the clone stub resolves a "cloning" promise after it feeds the lines, and the test awaits that. S1: give `start()` a `now` for the throttle | partly: `repoService({now})` (`hub/repos.mjs:206`) has a clock, but `start()`'s throttle uses `Date.now()` |

Excluded: lines 107, 235, 250 and 583 set `asked_at = Date.now() - STARTING_WAIT` exactly at the threshold. The code's later `Date.now()` only grows, so "timed out" holds at any load. Line 567 `joinedAt` is data passed with an explicit `at`.
Size: S.

### hub/prompts.test.mjs
Spawns permission-hook.mjs children against in-process fake hubs (port 0), and for the last two tests the real hub (`freePort` then spawn). The dominant dependence is the hook's real deadline and retry timers, and the hub's real ps.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 362 | the hook denies with a note when no answer comes by the hub's deadline, telling the hub it gave up, when the hub drops the prompt, and at once when the hub can't be reached | The fake hub gives a 1500 ms deadline and answers `pending` after a 200 ms `setTimeout` (319). `runHook` measures `Date.now()` around the child (25, 29). Asserts `r.ms >= 1400` (373) and `timed()`: warn over 2500 ms, fail at 5×, for the deadline (374); warn over 1000 ms, fail at 5 s, for unreachable (381). The unreachable port comes from `freePort()` (379), which is a race. | TIMING-CHECK (373, 374, 381), WAIT-ON-TIME, PORT | **Delete** the ms checks and assert behaviour instead. Deadline: S1, with fake `Date`/`setTimeout` in the hook via `--import` preload (the mechanism already used at 299-303), or refactor the hook into an exported `runHook({fetch, now, sleep})`. Assert the deny plus `DELETE /_hub/prompts/p1`, with the deadline reached on the fake clock. Unreachable: use port 1, and assert the deny plus exactly one POST attempt (preload fake fetch counts). The speed claim ("at once") goes to the bench if wanted (S7). | Partial: preload `globalThis.fetch` works today (299). The hook's `Date.now`/`sleep` are module-level (permission-hook.mjs:30,50-57); a preload can replace the globals. |
| 422 | a session that owns no board waits on the hub page by its folder and counts in the badge; a question needs a pick on each, and its answer still reaches the hook after the hub restarts | Real hub child (`startHub` awaits 'hub on', no limit), stopped and restarted (438-439). The hook child long-polls; while the hub is down its fetch fails and it sleeps `RETRY_MS` 2 s (permission-hook.mjs:14,57). Its POST has a 5 s cap (finding 4). `until` the prompt appears on the hub (431). The tick reads real load. | PROCESS, WAIT-ON-TIME | S4: an in-process hub (or the prompts HTTP handler alone) plus a hook with injected fetch/sleep (preload). The restart becomes "a new handler over the same prompts.json". | Partial (preload) |
| 451 | a remembered match bypasses prompts and push, survives a hub restart, and ends on owner change or session stop | Real hub ×3 starts; the hub spawns the shop board server (not awaited). Real `/bin/ps -o lstart` on the test pid (463); there is no `stallingPs` in this file, so the hub's liveness check runs real ps under a 3 s cap (live.mjs:45). `until` push queue.json exists (477). A hook to the live hub (482). | MACHINE, PROCESS, WAIT-ON-TIME | S4: the prompt and rule functions take `running`/`context` maps (`rememberRules(store, rec, {running, boards})`, used in-process at 61-298), so test the bypass and restart in-process. At least add `stallingPs` with `standIn` as sessions/boards do. | Yes for the functions; no for the hub |

Time only, result fixed:
- 298: the hook with a preloaded fake fetch, awaited on close.
- 325, 335, 355: the hook against a fake hub that answers at once.
- 183: `execFileSync` kickflip join with `KICKFLIP_HUB_PORT=1`, refused at once.
- 247: lock ordering with explicit promises, no clock.
- 21: `freePort` (for 379 see the row above).

Excluded: 384 (fixed `t0`, injected `now`); 467 snooze `Date.now()+1 day` (a day of slack).

Shared seam: one preload (`--import`) that fakes fetch, `Date` and `setTimeout` for the hook fixes the 362 and 422 hook halves with no refactor. Size S. Moving 422 and 451 off the real hub is M (in-process prompt handler, or the hub refactor).

### hub/push.test.mjs
`startFakeDevice` (in-process on a port) stands in for the push service and for the hub's needs.json. Each case runs push.mjs in a spawned node child (`inChild`).

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 27 (helper `inChild`, used by every test from 46 to 205) | all tests | a node child per call. Its sends to the device abort at 15 s (`hub/push.mjs:145`) | PROCESS, PORT | S4: import push.mjs in-process with an injected fetch and home | no (`hub/push.mjs:122,139` use global fetch, `KICKFLIP_HUB_PORT` env) |
| 72 | flushing the queue sends a board's one push as it is, … | asserts `badge` 5 from `device.needs`. `hubNeeds()` aborts at **4 s** and falls back to `{}`, so a loaded run gets `badge: undefined` and fails | PORT | S4 | no |

Size: M (push.mjs reads env and HOME at module level, hence the child).

### hub/restart-board.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 67 | Restart stops a board's session, restarts its server and resumes the session once the new server answers, … | hub child on freePorts(3). Starts 2 real `board/server.mjs` children. `until` `/shop/_claude/health` (line 91, 30 s budget) | PROCESS, PORT, WAIT-ON-TIME | S3/S4: in-process hub with injected server start. The unit tests at 150–190 already cover the flow with injected `sleep`/`now`/`portUp` | yes for `restartBoard({sleep, now, serverUp, portUp, run, live})` (used at 150–190). The hub process isn't importable |
| 110 (in 67) | same | asserts `sleeper.exitCode ?? sleeper.signalCode === 'SIGTERM'` right after the HTTP response. The sleeper is killed by the fake claude in another process, and this process only sets `signalCode` once its event loop has handled SIGCHLD. **Ordering race**, which load widens | PROCESS | S6: `await once(sleeper,'exit')` before asserting | n/a |
| restart internals (in 67) | same | the hub's `restartBoard` polls the new server's port with real sleeps up to its limit, and runs the fake claude through `runClaude` (60 s cap, 300 ms post-exit settle) | WAIT-ON-TIME, PROCESS | S1/S4 (the injection exists, as above) | yes in `restartBoard`. Not reachable through hub.mjs |

Excluded: 150, 169 and 184 use injected `sleep`/`now`/`portUp`, which is deterministic. Line 38 is inside the fake claude script.
Size: M.

### hub/restart-hub.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 14 | Restart hub answers once the hub service's restart is asked for, then runs it; … | hub child on a freePorts port ("hub on") | PROCESS, PORT | S3 | no |
| 57 (in 14) | same | `until` the stand-in restart command (`KICKFLIP_RESTART_CMD`, a node child the hub runs after responding) has written its line | WAIT-ON-TIME, PROCESS | S4: inject the restart runner into the hub's restart route and await its call | no (env var only) |

Size: M (hub importability).

### hub/rules.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 153 | hub Settings edits the hub rules, and a save that changes them sends every board a rules event | hub child on freePorts(2). The hub starts a real `board/server.mjs` child for orch | PROCESS, PORT | S3 + S4: in-process hub with injected board start | no |
| 174 (in 153) | same | `until` `/orch/_claude/health` answers (30 s budget) | WAIT-ON-TIME | S3/S4 | no |

Excluded: lines 308, 370 and the `usage.json at: now` writes are data. The gate compares them with fresh windows of minutes and hours, or with past or future ends. A spawned hub also runs `checkMachine()` (`hub/hub.mjs:600`), which reads the real Mac, but no asserted field depends on it: the gate's `state` ignores `machine`.
Size: M.

### hub/sessions.test.mjs
Spawns `kickflip` CLIs (awaited on close, no limit, `KICKFLIP_HUB_PORT=1` so the hub is refused at once). Fake claude and tmux scripts. `liveRecord` sleepers (`untilTestEnds`). A file-wide `stallingPs` stand-in. The dominant dependence is ps answered through a spawned `sh` under live.mjs's 3 s cap.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 20 (file) | (all CLI tests) | Every liveness check in the CLIs spawns the stand-in ps (`sh` with `kill -0`) under `execFileSync(..., {timeout: 3000})` (live.mjs:44-46). A loaded spawn reads "unknown", and start/resume refuse. | MACHINE | S4: preload a fake `live` into the CLI (the `cli` helper already takes `preload`, 98-99, as `doctorCLI` uses it), or call `startSession`/`resumeSession({live})` in-process | Partial (`resumeSession({live})` used at 777; `stopSession`/`hubSession({live})` at 752-753) |
| 247 | start runs claude --bg in the folder, in auto mode with isolation off, and records the new session as the owner | `t = Date.now()` (249). Asserts start returned in under 10 s (251), while the fake claude's detached child holds inherited stdio for 30 s (fake claude: `setTimeout(() => {}, 30000)`). | TIMING-CHECK | **Delete** the 10 s bound and keep the behaviour via S6: the lingering child runs `untilTestEnds()` instead of 30 s. A start that waits on its stdio then never returns, and the run's per-file timeout catches it. 264 (`hook.timeout*1000 > WAIT_MS`) compares config, not elapsed time: keep it. | n/a |
| 724 | while ps can't answer whether a session runs, the wake, the deaf push and the compact check wait for the next check, and start, resume, stop and hub refuse | Test `{timeout: 90000}`. `until` a spawned watcher vouches (749; listenState through the stand-in ps). Then `ps.stall(true)` with `KICKFLIP_PS_TIMEOUT_MS=200` (757): each CLI (resume, start, sessions) waits out real 200 ms timeouts against a stand-in that `sleep 10`s, leaving those sleeps behind. | MACHINE, PROCESS | S4: the in-process half already injects `live: () => null` (735-753). Do the CLI refusals the same way with `startSession`/`resumeSession({live: () => { throw unknown }})`, and check the `sessions` listing wording with a preloaded `live`. Then drop `{timeout:90000}` and the stall. The watcher `until` becomes `listenState(board, {running})` with an injected `running`. | Partial (as above; `listenState` boards.mjs:275) |

Time only, result fixed (CLI and fixture work, no time assertions):
- 180, 192, 207, 223 (doctor/init with preloaded fake `spawnSync`/fetch).
- 232, 270, 287, 310, 327, 339, 481, 559, 589, 610, 626, 644, 659, 670, 790, 849 (849: `tar` exec).
- 363, 422, 453, 473, 495, 512, 701, 773, 824: in-process with injected `now`/`live`/`resume`. 512's `at = Date.now()` is only the base of an injected `now`.

Excluded: 729 and 732 `Date.now() - 1 h` data; 467-style dates.

Shared seam: S4 `live` injection (most of it exists) plus the S6 fix to the fake claude. Size S–M.

### hub/shell.test.mjs
Starts in-process http servers (`hubStream` relay and `fakeBoard`s on port 0) with real timers: `retryMs:30`, `settleMs:10`. One test uses `fs.watch`. The dominant wait is `until` on SSE events.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 125 | a board's change reaches /_hub/stream as change {route} with the sidebar's new data, and the stream recovers after the board restarts | `until` ×5 (134, 139, 144, 146, 150): connect, change plus sidebar, reconnect after the board restarts (30 ms retry interval, stream.mjs:115), next change, release once no page listens | WAIT-ON-TIME, PORT (port 0, re-listen on the same port at 143) | S6: `listen()` returns events through an awaitable `next(type)` (no limit), plus S1 (`t.mock.timers` for the retry/settle timers, ticked explicitly) | Partial. Durations are options (stream.mjs:17); no clock or timer injection. |
| 159 | a watcher file written or removed in a board's data folder sends the sidebar at once, without a board change | `fs.watch` on data/ (stream.mjs:105). An `until` loop rewrites watcher.json until the hub reads it (173, the untilHeard pattern), then `until` ×2 (176, 179). `sidebarMs: 60_000` keeps the timer out. | WAIT-ON-TIME (fs.watch) | S2-like: `hubStream({watch})`, injected so the test fires the watcher callback directly | No (fs.watch hard-wired at stream.mjs:105) |
| 189 | a shared person's stream carries only their boards' changes and their view of the sidebar | `until` ×3 (198, 200, 205), then **sleeps 100 ms** (206) and asserts the shared stream got no ios change | NEGATIVE-SLEEP | S6: after the ios change, send a marker change on web and await it on the shared stream. Per-page FIFO then proves the ios change would have arrived first. Or S1 fake timers, flushing the settle. | partial (as 125) |

Excluded: 15, 67, 81 (pure).

Shared seam: give `hubStream` a `watch` option plus an awaitable event list in the test helper (S6), with fake timers for the 30/10 ms intervals. Size S.

### hub/slack-hear.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 161 | board.mjs slack thread, slack answer, slack say and slack task run through Hub's token | board CLI children talk to the fake Slack on a loopback port (`KICKFLIP_SLACK_URL`). Slack fetch aborts at 15 s (`hub/slack.mjs:76`) | PROCESS, PORT | S4: board.mjs `main` with an injected Slack fetch (`slackClient(token, {fetch})` exists) | partly: `slackClient({fetch})` is injectable. The CLI reads the URL from env |

Size: S.

### hub/slack.test.mjs

| line | test | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 82 | the hub saves the Slack token from its settings form and serves only the workspace and user | hub child on freePorts ("hub on") plus the fake Slack on a port | PROCESS, PORT | S3 | no |

Size: S once the hub is importable.

### hub/stale-board.test.mjs
Spawns the real hub plus a stand-in board server (`http` answering its pid) on `freePorts(2)` ports. The dominant wait is the hub's 2 s reconcile, polled with `until`.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 25 | a board server whose code changed on disk restarts once its board has no running builder, and its page reads restarting meanwhile | `until` 'hub on' (45); `until` Shop answers (46; reconcile, spawn, listen); `until` the "restarts once no builder runs" log (52; 2 s reconcile hashes `boardCode`); `until` "restarting it" (56); `until` the new pid (64; the stand-in's own 50 ms poll on the release file); `until` the hub proxy finds it up (69; probe). The 15 s tick reads real load. | PROCESS, PORT, WAIT-ON-TIME (2 s tick) | Extract the reconcile decision (hub.mjs:400-410: `onDisk` vs `p.code`, `openBoardBuilders`) into a pure function and table-test it. Keep one wiring test on S3 (in-process hub, `await reconcile()`, injected `boardCode`/`openBoardBuilders`/spawn). The restarting landing page (57-62) is a `/_hub` render: test it with the proc state injected. | no |
| 82 | with KICKFLIP_CODE_RESTARTS=off, as a try run's demo hub runs, a board server whose code changed keeps running | `until` ×2 (99, 100), then **sleeps 5000 ms** (104) "the hub checks every 2 seconds", then asserts no restart | NEGATIVE-SLEEP | Same pure decision with restarts off. `onDisk` is null when `CODE_RESTARTS` is false (hub.mjs:400), which is one assertion. Or S3: `await reconcile()` twice, then assert. | no |

Shared seam: one hub refactor (pure decision plus in-process reconcile) fixes both. Size M; without the hub refactor it is S for the pure-decision half.

### hub/try.test.mjs
Starts real build scripts (`spawn` in try.mjs:474, one per start/tick), a few stand-in leftover processes, and in one test a real hub.mjs on a port. Most tests also run real git, ps, lsof and a fake tailscale. The main wait is `until(state()…)` (30 s budget, fails at 150 s), polling try.json until the real child reaches ready or failed. Underneath that sit try.mjs's own real timers: a 250 ms port-probe interval (try.mjs:520), endGroup's 4 s SIGTERM→SIGKILL plus 1 s (try.mjs:76), and exec timeouts (git 3 s at try.mjs:28, ps 5 s at :81/:107, lsof 10 s at :91, tailscale 10 s at :285, origin git 10 s at :956).

Injection points already in createTryManager (try.mjs:150): `now`, `answers`, `lingers`, `log`, `waiting`, `event`, `gate`, `busy`. Missing: a spawn/runner, any settle signal, the endGroup grace, and the exec runner (git/ps/lsof/tailscale). resetBranch/pullBranch take `run` (try.mjs:962, :981), but fetchTryBranches calls originGit directly (try.mjs:1022).

File-wide rows (they apply to every test below that calls start/tick):

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 62 | (all: fixture `git()` helper) | `execFileSync('git', …, {timeout: 60_000})` builds fixtures in beforeEach and in tests | PROCESS | drop the `timeout:` (fixture only; the run's per-file timeout is the ceiling) | n/a, test-side change |
| try.mjs:28 | (all that start/tick) | the code under test runs `git rev-parse`/`status` with a **3 s timeout**. On a loaded host a slow git rejects `start()`, or a tick logs a failure, so the result changes | MACHINE | S4: inject the git runner into createTryManager, or at least raise the timeout to what originGit uses (10 s) | no (`git` is a module const) |
| try.mjs:520 | (all web-serve tests) | ready waits out real 250 ms setInterval probes, even with `answers` injected | WAIT-ON-TIME | S1 (`t.mock.timers` setInterval) or S3t | `answers` yes; interval no |

Per-test rows:

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 123 | an app run uses only the fixed script and arguments… | real script exits; `until` ready ×2 (127, 138) | PROCESS / WAIT-ON-TIME | S3t (await settle; keep the real script: it tests env, cwd, log mode) | no |
| 197 | a failed run writes one failure status line… | `until` failed (208), `until` ready (216); fsp.appendFile hold + one setImmediate (ordering only, not time) | PROCESS / WAIT-ON-TIME | S3t | no |
| 220 | a second concurrent start returns 409 | spawns a forever-script, no wait; afterEach `manager.stop()` runs endGroup (SIGTERM, up to 5 s) | PROCESS (time only) | S4 (fake child) or leave | no |
| 228 | a web run waits for its port and stays up… | `until` log has 'port' (236), `until` ready (239) over the 250 ms probe; clock injected for hours | WAIT-ON-TIME | S3t + S1 for the probe interval | `now`, `answers` yes |
| 252 | a card serve stops and drops its entry once its card is Done… | `until` ready ×4 (258) | WAIT-ON-TIME | S3t | no |
| 283 | a serve that exits after it was up starts again up to 3 times… | `until` relays+ready (302, 307, 318). Script polls a go/n file every 20 ms (already S5 for the exit); restart path | WAIT-ON-TIME / PROCESS | S3t (+ the existing go-file S5) | `now` yes |
| 324 | a serve past the board's Maximum parallel serves is refused… | `until` ready (335, 339, 344, 356) | WAIT-ON-TIME | S3t | `busy` yes |
| 361 | Kill stops a running or ready serve… | `until` (369, 377, 390) | WAIT-ON-TIME | S3t | no |
| 394 | a hub restart serves each card that was up again… | `until` (400, 406) | WAIT-ON-TIME | S3t | no |
| 410 | a port announcement followed by exit before readiness fails… | `until` thread line (414) after the real script exits | PROCESS | S3t | no |
| 419 | the auto-build tick refreshes head… | `until` ready (429), `until` thread (437) | WAIT-ON-TIME | S3t | no |
| 444 | main builds at the remote tip… | `until` (449, 462, 479, 497). Script polls a 'hold' file every 20 ms (S5 already) | WAIT-ON-TIME | S3t | `waiting` yes |
| 503 | a board's build target runs .kickflip/build-<target>… | `until` (522, 527, 531, 541) | WAIT-ON-TIME | S3t | no |
| 552 | builds waiting on each other when the hub restarts… | `until` built (573), `until` all ready (579). Script retries mkdir lock via setTimeout 20 ms and polls 'hold' (S5); restart → stop → endGroup | WAIT-ON-TIME / PROCESS | S3t | no |
| 591 | a web script serves root paths and upgrades through the relay… | picks a free port by listen-and-close, then a script binds it (another parallel file can take it: PORT race). Real `probe` (1 s http timeout). `until` (602, 665, 672). **661: sleep 100 ms, then asserts the shared response did NOT end** | PORT / WAIT-ON-TIME / NEGATIVE-SLEEP | S3t for the waits. For 661: endUnshared() is synchronous (try.mjs:301), so assert right after the call (or after one setImmediate) instead of after 100 ms. Port: let the script bind :0 and print its port | gate yes; port no |
| 680 | the relay hands the app an owner's request without… | same free-port race; `until` (693) | PORT / WAIT-ON-TIME | as 591 | no |
| 710 | a stopping hub leaves its try ports mapped… | `until` (716) | WAIT-ON-TIME | S3t | no |
| 743 | a main re-serve keeps the old server on its port… | `until` (752, 759, 768, 773, 782, 785, 790) | WAIT-ON-TIME | S3t | `answers` yes |
| 798 | a build that prints the old main server's port stops the old server… | `until` (805, 810) | WAIT-ON-TIME | S3t | yes |
| 828 | a main serve that is refused beside the old one… | `until` (835, 839, 853). The script checks a pid lock with kill 0 | WAIT-ON-TIME | S3t | no |
| 858 | the single main worktree of a hub from before the pair… | spawns 2 stand-ins; `until` ready (874); `await gone` (child exit, S6). The code finds them with **real ps (5 s timeout) + lsof (10 s timeout)** (try.mjs:106) | PROCESS / MACHINE | S4: inject a process lister (`processesIn`) into the manager; await exits by S6 | no |
| 881 | a server left in the old single main worktree is stopped… | same; `until` (896, 897) | PROCESS / MACHINE | S4 + S6 | no |
| 902 | a local board's main builds the tip of its recorded branch… | `until` (909) | WAIT-ON-TIME | S3t | no |
| 913 | main keeps its fixed port across merges and restart… | `until` (923, 930, 936, 947) | WAIT-ON-TIME | S3t | no |
| 955 | the poll fetches each non-hub board branch… | real git fetch under the code's ORIGIN_TIMEOUT_MS 10 s (try.mjs:956) | PROCESS | S4: give fetchTryBranches a `run` option as pullBranch has | no (pullBranch/resetBranch yes, fetchTryBranches no) |
| 979 | the poll waits out a GitHub board fetch that takes longer than a few seconds… | fake git `sleep 3.5` and passes only if 3.5 s plus the real git stay under the 10 s timeout | TIMING-CHECK → **delete** the sleep: it re-measures a constant (try.mjs:956). Keep the `GIT_TERMINAL_PROMPT=0` check with a fake git that doesn't sleep | S8 (the timing part) | n/a |
| 992 | a GitHub board fetch git refuses records git's own error… | fake git exits 128 at once; log regex `after \d+ ms` accepts any number | (time only, result fixed) | none needed | n/a |
| 1002 | a merge's fetch reaches only the merged board… | real git fetch, 10 s code timeout | PROCESS | S4 as 955 | no |
| 1023 | a merge's Main refresh covers only its board and runs after a tick… | `until` checks===1 (1031, in-process, passes on the first poll). **1035: sleep 20 ms, then asserts checks===1** (no second check ran alongside) | NEGATIVE-SLEEP | Have the injected `waiting` count calls in flight and assert the maximum is 1 after `Promise.all`. No sleep needed | yes (`waiting`) |
| 1042 | on a plain git remote board the poll moves a pushed card to Done… | real git ls-remote/fetch, 10 s timeout | PROCESS | S4 as 955 | no |
| 1080 | the poll fast-forwards a local board's checked-out branch… | real git fetch under 10 s timeout | PROCESS | S4: let pullMains pass `run` through to pullBranch | partly (pullBranch `run` yes, the manager doesn't pass it) |
| 1097 | a pull uses the board's recorded branch… | same | PROCESS | S4 as 1080 | partly |
| 1110 | a pull only fast-forwards… | same | PROCESS | S4 as 1080 | partly |
| 1140 | a board whose pull throws is logged… | same | PROCESS | S4 as 1080 | partly |
| 1153 | a board's own clone is reset hard to origin's branch… | same (resetBranch) | PROCESS | S4 as 1080 | partly |
| 1172 | the pull reads running while it fetches, which a restart clears | fake git `sleep 0.6`, then `until` running===true. **A race: if `until`'s poll misses the 0.6 s window, running is already cleared and the until never holds**, so the test fails at 150 s | WAIT-ON-TIME (load decides the result) | S5: the fake git fetch blocks until the test writes a release file; or S4 with a `run` that awaits a deferred promise | partly |
| 1190 | a tap pulls now and rebuilds Main only when the pull brought commits… | `until` (1196, 1202) + real git | WAIT-ON-TIME / PROCESS | S3t + S4 | no |
| 1218 | the hub build route enforces loopback and fixed inputs | **spawns hub.mjs** on a listen-and-close free port (PORT race) and awaits 'hub on' on stdout (S6, no limit). A script binds a second free port. `until` ready (1254). Hub's 15 s tick (hub.mjs:596) runs `checkMachine()`, which reads the **real load** (machine-gate.mjs:22). If the test crosses 15 s on a loaded host, busy() makes `/_hub/build` answer 409, not 202 | PORT / PROCESS / MACHINE | Needs hub.mjs as an importable `startHub({manager, port: 0})` (S2/S3 for the hub). Then call the route handler in process with an injected try manager. Short of that, set an env that turns off the machine check | no (hub.mjs is a top-level script) |
| 1278 | a running script with no port fails after sixty minutes | already S1 (mock setTimeout for the 60 min deadline); `until` started (1282), `until` thread (1286) on the real child | WAIT-ON-TIME | S3t for the remaining waits | S1 yes (mock timers) |
| 1292 | an unanswered announced port fails after sixty seconds | clock injected; `until` (1296, 1298) waits the real 250 ms probe interval to see the moved clock | WAIT-ON-TIME | S1 (mock setInterval) + S3t | `now` yes |
| 1303 | shutdown kills the whole process group, escalating when a server ignores SIGTERM… | `manager.stop()` waits endGroup's **real 4 s** before SIGKILL (try.mjs:76), then `until` pid gone (1314) | PROCESS (≥4 s every run) | S1: make the endGroup grace a createTryManager option (as stopRuns has `grace`), or mock setTimeout around stop | no |
| 1319 | an automatic validation refusal records one failed head… | no wait; tick and stop (git 3 s timeout, file-wide row) | (time only) | n/a | n/a |
| 1349 | a failed Tailscale registration fails the run… | `until` (1355, 1364); SIGTERM to the server, then `until` relays===3 && ready (1368) through the restart path | PROCESS / WAIT-ON-TIME | S3t | no |
| 1375 | card ports skip every board's fixed main port… | `until` (1384, 1391) | WAIT-ON-TIME | S3t | no |
| 1399 | exhausted try ports fail clearly… | `until` thread (1409) | WAIT-ON-TIME | S3t | no |
| 1414 | startup cleanup failure logs and still allows a build | `until` (1422) | WAIT-ON-TIME | S3t | no |
| 1442 | the prototype serve's relay drops the headers that refuse a frame… | free-port race ×2 (`free()`), real scripts bind them; `until` (1461, 1463) | PORT / WAIT-ON-TIME | as 591 | no |
| 1475 | the board's base prototype worktree is served while an open question links a served round… | `until` (1489, 1499, 1508, 1513) | WAIT-ON-TIME | S3t | `now` yes |
| 1520 | a move of the base worktree to a new commit restarts its serve… | `until` (1533, 1546) | WAIT-ON-TIME | S3t | `now` yes |
| 1553 | a run's process group is recorded in try.json while it runs… | `until` groups port (1556) | WAIT-ON-TIME | S3t | no |
| 1562 | a hub that died hard stops a recorded group still running its script at startup… | spawns leftover + stranger; initialize reads **real ps (5 s) + lsof (10 s)** and runs endGroup | PROCESS / MACHINE | S4: inject the group lister | no |
| 1577 | a stopped leftover whose port still answers posts a red fault… | same ps/lsof read; `lingers` injected | PROCESS / MACHINE | S4 | `lingers` yes; ps no |
| 1587 | with no open question the base serve stays up for 30 minutes… | `until` (1599) | WAIT-ON-TIME | S3t | `now` yes |

Excluded: 141, 171, 546, 1343 and 1425 start no script and have no waits. 1425 asserts nothing launched after a tick, but `waiting` refuses before any spawn, so no time is involved. `clock = Date.now()` (97) is a base for injected time, not arithmetic in an assertion. Line 999's `\d+ ms` accepts any duration.

**Shared seam:** one S3t (`manager.settled()`, or `manager.next(key, state)` resolving inside try.mjs `update()`) replaces about 40 `until(state()…)` calls across 123–1587. Then S1 on the 250 ms probe interval and the endGroup grace (1292, 1303, all web serves). Then S4 for exec: a git/ps/lsof runner option fixes the file-wide 3 s git timeout and 858/881/1562/1577; a `run` on fetchTryBranches and pullMains fixes 955–1172. The real script spawn can stay, since its env, cwd and log are what most tests check, once its readiness is awaited by event and not by poll. 1218 needs hub.mjs to become importable (shared with gate.test.mjs). Size: **L** (the biggest file here; S3t plus an exec-runner option in try.mjs).

### shared/gh.test.mjs
Starts a fake `gh` on PATH (spawned through `execFile` with no timeout, awaited). No servers.

No rows: every result is fixed regardless of time.
- `inAnHour()` (16) is an hour ahead, and 74's `Date.now() - 1000` is already past, so load only moves both further the safe way.
- 113 `runCommand`'s 10 s timeout (service.mjs:11) never applies: the gate refuses before spawning (asserted at 114).
- 94: fixed dates with an injected `now`.

### shared/test-helpers.test.mjs
Pure in-process test of `until` itself, using the real clock.

| line | test name | waits on | kind | seam | injection point exists? |
|---|---|---|---|---|---|
| 8-11 | until waits past its budget with a warning, and fails only at 5× the budget | a predicate true after real 120 ms; asserts more than one poll and exactly one warn (budget 50 ms) | TIMING-CHECK | S1: `until` takes a clock/sleep (or `t.mock.timers` on Date + setTimeout from timers/promises) and the test ticks | no: until uses `Date.now` and `setTimeout` from node:timers/promises directly (shared/test-helpers.mjs:47-53); `t.mock.timers.enable({apis: ['setTimeout']})` does not mock node:timers/promises on Node 26 (checked) |
| 14-15 | same | `until(() => true, …, 50)` asserts no warn: fails if the first predicate call returns after more than 50 ms of real time | TIMING-CHECK | S1 | no |
| 16-18 | same | `until(() => false, …, 50)` rejects; asserts `Date.now() - started >= 250` | TIMING-CHECK | S1 | no |

**Shared seam.** One S1 change covers all three. Decision: S1 rather than bench or delete, because this tests the helper's contract, not speed. Once no test calls `until`, the helper and this test are deleted together (S8). Size: S.

## Results fixed, run time only

These files spawn CLIs or git with no time limit and no timing assertion, or are pure or run on fake timers. Load makes them slower, not wrong.

- bin/install.test.mjs: spawnSync of kickflip init, update, uninstall and the status line with stub tools; its `timeout:` values are hook-settings data.
- board/affected.test.mjs: git fixtures; two tests run `board.mjs test`, whose nested `node --test` limits (5 min per test, 15 min per run, board/worktree.mjs:178) never bind on one-line fixtures.
- board/block-past-todo, board-questions, board-settings, gates, hub-lines, patch, domain (`now` passed in; its `until` at 1148 is a local helper, not the test helper).
- board/phases, progress-review, backdrop-press, prototype-served: vm contexts get the real `setTimeout`, but no test waits on it; prototype-served 143 uses captured fake timers.
- board/prototype-kit, prototype-switcher, hub/sw: fake timers; `setTimeout(0)` is one macrotask.
- hooks-plugin/hooks/board-data-gate, usage-gate: spawnSync hooks.
- hub/presence, schedule, self-restart, usage, views (relative ages with an hour of margin), upgrade (`t.mock.timers`: the target pattern).
- hub/repos.test.mjs: a child's `setTimeout(20)` only splits stderr chunks, and the assertion joins them.
- hub/restart-port.test.mjs: the stand-in server's child `setTimeout` keeps the port for a while after its leader exits; the hub waits on the group's exit, not on that time.
- scripts/release.test.mjs, shared/repos, service, usage-gate: injected `now`.
- shared/gh.test.mjs: a fake `gh` on PATH with no limit; its relative dates sit an hour or more from any edge.
- shared/owner-check.test.mjs: one in-process `listen(0)` request under `runCheck`'s 20 s abort (low risk; `runCheck({fetchImpl})` exists, shared/owner-check.mjs:113).
