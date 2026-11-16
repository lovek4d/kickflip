---
status: superseded by 2026-11-16-0328-the-board-server-drops-its-file-watch
---

# A test waiting on the board to hear a write writes again until it acts

Card #638. Four server-reaction tests failed in every full-suite land and passed alone: headless.test.mjs "the server launches the builder for a tap and a pull…" and "a lander whose process is gone…", server-builds.test.mjs's probe in `withBoard`, and server-stale.test.mjs "with auto implement on…". Each wrote a file once and waited for the board server, child of the test, to act on the event its file watch reports.

Instrumented full runs (5 test files side by side, the runner's cap on this 10-core Mac, load 4.8–8.7) logged every name each server's watch reported, through a throwaway `--import` that wrapped `fs.watch`, and the time each test wrote its trigger:

- **The watch missed the writes; the server didn't act late on them.** In one run no board server in the suite heard any event between about 75 s and 150 s in. The lander, probe and auto-pull servers had heard nothing at all 100 s after their trigger write, while a server started after them began hearing at 150 s. In the next run the tap-and-pull test's server heard nothing for 27 s after it started: not the test's setup, not its own writes for the first lander and the tapped builder, and not the write that readied H2. The first name it heard was a nudge written 2 s after that write, and H2 was pulled right after it. A write the OS drops never reaches the server, so the wait can only fail.
- **A count of runs can be met by the wrong run.** The tap-and-pull test waited for a third launch. The fake builders exit at once, so once the wait passed 60 s the server's minute check relaunched the tapped builder, and that relaunch met the count. The test failed on H1's brief at 60 s, not at its 150 s limit.
- **Late events also send extra changes.** server-builds' tap test saw 2 change signals where it expected 1: the server's own startup writes were reported 3.5 s after the probe.

What changed:

- **`untilHeard(predicate, message, nudge, budget)`** in `shared/test-helpers.mjs` waits as `until` does and, every 2 s until the predicate holds, writes `nudge`, a file under the server's watch that no board reads. Each write is one more event, and any event has the server re-read the board, so a dropped trigger is read on the next nudge that gets through. Its failure says how many nudges it wrote. Each test still asserts once on what the server did. The board is built once per data version, so the server's minute check reads the cached board and never sees a write its watch missed. Without a nudge, nothing makes the server read it.
- **The four tests use it**, and so do the waits of the same shape that failed in the loaded runs: auto-triage's "the server saw the triage's own change", the arrivals grill test's three waits, and the planner-brief launch waits in headless.test.mjs. The probe in `withBoard` is its own nudge.
- **The tap-and-pull test counts each run by what it launched**: the H2 build, H3's and H4's landers. A relaunch of the tapped builder no longer meets a wait.
- **`withBoard` waits for 2 s of quiet** from the server's watch after it hears the probe, as the folder-churn test waits on its marker (docs/adr/2026-11-12-2135-the-folder-churn-test-builds-its-site-aside-and-bounds-its-churn.md). Startup events that arrive late come in before the test counts signals.
- **server-builds' tap test taps again** when 5 s pass with no change signal. Its signal comes only from the server hearing its own append to the events file, and a nudge would add a build of its own. Each tap still builds the board once, so the test asserts one build per tap and between one change signal and one per tap.
- Every wait keeps `until`'s 30 s budget and fails at 150 s, inside the runner's 300 s.

With nudges, the loaded runs had these waits react after 0 to 13 nudges, at most 27 s. The ones that needed none still pass with no extra write.

A real board's watch drops writes the same way under load. The minute check doesn't recover them, because it reads the board cached by data version. That is a product matter for its own card. These tests check what the server does with a change it hears, not whether the OS reports every write.
