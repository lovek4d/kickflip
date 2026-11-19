# try-main is split by area, and the watcher test kills its session

Two files cut land runs off at the 15-minute limit (kept, with background priority and the busy-host wait).

- board/server.test.mjs "a watcher that just exited on an event…" spawns a session child that lives until the test
  ends. A failed assert left it running and the file open, so it now stops the child in `t.after`. The watcher's
  first line was asserted by position, but the record-only waits-history event can print first; the test now asserts
  the reply line appears once among the lines.
- hub/try-main.test.mjs showed no git fetch hang: its cutoffs were a port clash (fixed by an in-process hub with no
  relay port) and a file whose 41 tests, run one after another, took minutes under load. It is split by area so the
  runner runs the parts side by side: hub/try-main.test.mjs (main serve), hub/try-pull.test.mjs (poll fetch and pull),
  hub/try-run.test.mjs (build route, ports, shutdown, relays) and hub/try-base.test.mjs (the base prototype serve).
  hub/try-fixture.mjs holds the setup they share.
