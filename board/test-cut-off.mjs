// docs/adr/2026-11-24-2240-a-test-file-cut-off-by-the-runs-limit-reruns-on-its-own.md
// The exit code of a test file's process ended by its run's cutoff, near it or started after it (exit-with-run.mjs),
// which nodeTests reads in the runner's TAP to tell a cut-off file from a failing one. 75 is EX_TEMPFAIL: try again.
export const CUT_OFF_EXIT = 75;
