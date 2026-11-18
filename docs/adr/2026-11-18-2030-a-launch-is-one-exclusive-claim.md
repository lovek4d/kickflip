# A launch is one exclusive claim

The board server launched two builders for one card 11 seconds apart. The first server launched the builder and held
that fact only in memory; the hub restarted, and the new server saw an In Progress card whose record the builder had not
yet opened, and launched again. Writing a record before spawning would still let two live servers (the old one and the new
one) both check, both find nothing, and both launch.

## Decision

Every launch takes an exclusive claim first (`shared/launch-claim.mjs`). The claim is a file in the board's
`data/launches/`, named for the card and the agent, linked into place whole so the create is atomic: the process whose
create succeeds spawns, and a process that finds the file launches nothing.

- The claim holds the launched process's pid from its spawn (`launchAgent`'s `onSpawn`), before the agent names its
  session. A claim whose process is gone (or, before a pid is known, whose claimer is gone) is stale: one process moves it
  aside by rename and claims again through the same exclusive create, so a relaunch also happens once.
- It is freed by `builder done` and `builder stop` (closing or stopping the record), by an abandoned launch, and by a
  launch that rejects.
- `headless.mjs launchBuilder` and `resumeBuilder` are the one place the board server launches an agent, so a builder, a
  lander, a rebase run, a planner, a visual agent, a reviewer, a helper and a resume are all behind it. A launch that
  lost the claim answers null, and each caller leaves the card's tracking as the winner wrote it.
- The hub's fresh `/teach` start of a course with no recorded session (`resumeCourse`) takes the same claim, held until
  the session is recorded as the page's owner.

## Already safe

- `startSession` through `freshSession`, `freshHubSession`, `resumeSession`, `restartSession` and `restartBoard`: all run
  under `withSessionLock`, a file lock across processes, and refuse a live session inside it.
- A new board or course: `taken` under the manifest lock lets one request make the route.
- `resumeCourse` of a recorded session: `resumeSession` is locked as above.
- A held card's Merge (`runHeldMerge`) is a land, which the land queue serialises; an offered script's Run is guarded by
  its recorded decision and `scriptTaps`.

## Left

A server killed between the exclusive create and the agent's spawn leaves a claim that falls when its claimer is gone, so
the next pass launches: at most one launch, as the claim never held a second.
