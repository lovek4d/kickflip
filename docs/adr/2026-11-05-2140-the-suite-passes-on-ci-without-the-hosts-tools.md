# The suite passes on CI without the host's tools

The v0.5.1 release run failed at `node --test` on ubuntu-latest, Node 22, with no `claude` or `codex` installed. Each
failure was a test leaning on something the host happens to have.

- The auto-implement test in `board/server-stalled.test.mjs` expects the pick's Codex reading to be `not logged in`. That
  reading is `not installed` when no `codex` is on PATH, so the test puts an executable `codex` in a directory at the
  front of the board server's PATH; its HOME has no `.codex/auth.json`, so it reads as installed and not logged in
  on any machine.
- The ETag test in `board/server.test.mjs` took a version, then POSTed an event and expected the next GET to carry the
  POST's version. A card new to the board is marked read by the server right after the board change that brought it
  (`markNewCards`, `read-marks-live-on-the-board`), which gives each card a `readAt` and so a new version. Whether that
  write landed before the POST's build or after it depended on timing. The test now waits for the new cards' `readAt`
  before the first read, so the POST is the only change left. The server is unchanged: that write is a real change to
  the board and its version should move.
- `nodeTests` passes `--test-timeout`, which Node 26 applies to each test and Node 22 applies to the whole file. On 22 the
  slow file fails as timed out and its other tests don't run, and the failure is named by the file, not the test. The
  per-test-limit test in `board/suite-run.test.mjs` puts the test that follows in its own file, which runs on both, and
  accepts either name. The limit still fails a test (or on 22 its file) as timed out, and still lets the rest of the suite
  run.

- Two more tests compared two reads of the board across that same read-mark write (`/api/board` gzip, and the `?since=`
  patch), and Node 22's slower run exposed them; they wait on the same `cardsMarkedRead` helper.
- The Chrome layout test's cleanup failed with ENOTEMPTY on the Mac under Node 22, Chrome's helpers still writing to the
  profile folder after the browser exited; the removal retries for longer. CI has no Chrome at that path, so the test is
  skipped there.

The full `node --test` was run on Node 22 with neither `claude` nor `codex` on PATH, and on the host's Node 26.
