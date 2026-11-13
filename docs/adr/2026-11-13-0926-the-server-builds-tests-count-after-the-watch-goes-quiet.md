# The server-builds tests count after the watch goes quiet

A late event, the startup's or a nudge's, is one more build, and its change signal can be folded into another's. The server-builds tests wait for the watch to go quiet (`ctx.quiet`) before counting, and both expect one build per signal (per tap in the tap test), plus at most one from a late event.

Superseded by [the board server starts in process, and its tests await settled()](2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md): the tests have no watch, so they count exactly.
