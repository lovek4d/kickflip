# Builds run at background priority

Amends 2026-11-12-1600-the-test-runner-caps-concurrency-to-half-the-cores.md.

Several builders, a land's test run and a try serve at once could take enough CPU and disk that the board server, and with it the board page, stopped answering. The board and hub servers now always win: every process the board starts for building runs at background priority, and they stay at normal priority.

`backgroundArgv(argv)` (board/background.mjs) is the one seam. It wraps the argv for the platform:

- macOS: `taskpolicy -b`, background QoS: efficiency cores and throttled disk IO.
- Linux where a user scope starts: `systemd-run --user --scope -q -p CPUWeight=20 -p IOWeight=20`, a cgroup scope at a fifth of the default CPU and IO weight. Having `systemd-run` on PATH isn't enough: without a user manager to reach, every launch through it would fail, and the hub's own systemd user service doesn't promise one to every caller. So each process probes once, running `systemd-run --user --scope -q true` with a 3-second limit, and uses the scope only when that exits 0.
- Elsewhere: `nice -n 19`.

Each wrapper execs the command, so the process keeps the pid and process group spawn gives it, and what reads or kills a run by pid or group is unchanged. Its children inherit the priority. Going through it: builders, landers, planners and helpers (agents.mjs launchAgent), a land's and a builder's test run (worktree.mjs nodeTests), render checks (render-check.mjs) and try serves (hub/try.mjs). launchAgent checks the agent's binary is there before it spawns, since the wrapper, not the agent, is what spawn starts.

A land's `node --test` run starts `max(2, floor(cores / 2))` files at once, two at least where it was one.

Left out: memory caps (Linux `MemoryMax`) and holding new launches under memory pressure. They come in a follow-up only if a measurement shows background priority isn't enough. Docker was weighed and set aside: on macOS it is a Linux VM that takes its RAM up front, needs Claude's login passed in, and runs tests on a different OS than the hub.

Board latency, measured in T-773's quiet-host round 2: `GET /_claude/needs` from loopback, which builds the full board with no cookie (`board()` in board/server.mjs), sampled every few seconds. It takes about 78 ms idle. During a full land suite at 5 or at 10 files at once, background priority held the build time at p50 81–87 ms and p95 105–132 ms. The board stayed as quick at either file count.

The probe is not `/api/board`: since c9e6fba6 (11/18) that path is off AGENT_PATHS and answers a 401 sign-in refusal in about 0.5 ms, so a curl on it times the refusal, not a board build.
