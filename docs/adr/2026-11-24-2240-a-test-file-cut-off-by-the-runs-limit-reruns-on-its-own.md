# A test file cut off by the run's limit reruns on its own

Amends [a test file still running near the run's cutoff ends by name](2026-11-22-1400-a-test-file-still-running-near-the-runs-cutoff-ends-by-name.md), which made a file ended at the cutoff an ordinary failure.

T-855's land (11/24, load average about 26, two lands testing at once) ran 204 test files: 2118 tests passed and 44 files failed in 14m59s. 43 of the 44 were files the run's cutoff ended, and 35 of those were ended 0 to 5 seconds after they started: `node --test` kept starting queued files after the run's end, each of whose near-cutoff timer fired at once. Nothing was slow inside a file; the set didn't fit in 15 minutes on that host. As failures, the 43 went to `failingOnBase`, a second long run on main on the same busy host, before the land refused. T-859's run was killed whole at 15 minutes with no totals: hub/leftovers*.test.mjs were started in its last seconds, after its end (a file started 29 seconds past the end warned of a negative timeout, and theirs started later still), and the processes left at the kill include the `ps` their near-cutoff timer runs before it exits. Alone, those files pass in 12 seconds at a load of about 20.

Decision:

- A test file's process the run's cutoff ends exits `CUT_OFF_EXIT` (75, EX_TEMPFAIL; board/test-cut-off.mjs), not 1. A file the runner starts at or after the run's end exits 75 at once, from the preload, before its code loads, with `Error: test file not started: the run's 15-minute cutoff is near`. A file's own `fileLimit` still exits 1: that is a hang, not the host.
- `nodeTests` reads `exitCode: 75` in the runner's TAP and keeps those files out of `failures` and `failedFiles`, in `cutOff: {after, files, failures}`. Its result line reads `N passed, M failed, K cut off`.
- `passTests` never runs a cut-off file on base. When the cut-off files are all that failed, or every other failing file fails the same on base, it runs just the cut-off files again once on their own; every other file already passed on the same commit. A failure or cutoff in that rerun refuses (`tests cut off by the run's limit of 15 minutes twice in …`); the rerun is not run on base. Beside a real failure the cut-off files are named in its refusal and not run again.
- A run started from inside a test replaces any inherited copy of the preload with its own, so another checkout's copy can't read the run's settings by older rules.

The rerun doesn't wait for a quieter host: `untilHostEases` reads busy only at 4x the cores, above what T-855 failed at, and the rerun is a few files where the first run was the whole set. A run killed whole at its limit still refuses as "tests hung past …"; a test script's run (a repo's `.kickflip/test`) never has cut-off files.
