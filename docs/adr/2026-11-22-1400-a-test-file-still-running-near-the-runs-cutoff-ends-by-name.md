# A test file still running near the run's cutoff ends by name

Amends [a test file still running past its limit fails by name](2026-11-19-2330-a-test-file-still-running-past-its-limit-fails-by-name.md).

The per-file limit (10 minutes) counts from a file's own start, and a land's full suite takes about 13 of its 15 minutes. A file that starts in the run's second half and stalls never reaches its own limit. The run's cut-off kills the whole run first, which loses the TAP of every file still open (the runner prints a file's tests only once the file ends) and refuses with "tests hung past 15 minutes in" each file still running. The lands of 11/22 (T-514, T-811, T-814, T-815, T-820) each named four or five such files (hub/sessions, hub/try*, hub/views) with nothing to say which of them waited on what.

Decision: `nodeTests` also hands each run's file processes the run's end, `KICKFLIP_TEST_RUN_ENDS`: its start plus `limit`, less 30 seconds or a quarter of `limit` when that is shorter, so the runner has time to report. The preload (board/exit-with-run.mjs) arms the file's timer for whichever comes first, its own `fileLimit` or that end. When the end fires, the file writes `Error: test file still running near the run's 15-minute cutoff after <its age>, held open by <resources>, waiting on <commands>` and exits 1. Either timer names the commands the file's descendant processes still run (read with `/bin/ps`, since a test may put a stub `ps` first on PATH). The runner reports each such file as a failing test named by the file, prints the tests every other file ran, and exits before the cut-off. The land then refuses as a failing run, naming the files and what each was waiting on.

The run's cut-off still ends a file whose event loop is blocked, since its timer can't fire. That refusal is still "tests hung past …".

What held the 11/22 lands was host load, not a hang, a lander's environment or background priority (board/background.mjs). On that host (load 15–30, 21.5 of 22.5 GB of swap in use), these runs were all taken while it was busy:

- three hub/try*.test.mjs files ran past 7 minutes in a plain `node --test` run, both at normal priority and under `taskpolicy -b`;
- hub/try.test.mjs run on its own passed each test it reached, 20 of its 29 in 321 seconds, with single tests taking 20 to 55 seconds;
- their git commands sat in disk wait for seconds each.

A quiet host runs hub/sessions, the hub/try* files and hub/views together in 75 seconds. Those files spawn real servers, git repos and CLIs, so they are the ones a loaded host leaves running at the cutoff.

Amended by [a test file cut off by the run's limit reruns on its own](2026-11-24-2240-a-test-file-cut-off-by-the-runs-limit-reruns-on-its-own.md): a file the cutoff ends, or the runner starts after the run's end, exits 75 and reads as cut off, not failed; a land reruns such files once on their own and never on base.
