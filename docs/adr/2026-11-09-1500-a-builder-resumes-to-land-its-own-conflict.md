# A builder resumes to land its own conflict

A land that needs work after the builder handed back (a verified build, a Merge tap's rebase conflict or failing test, a PR that conflicts with its base) resumes the card's builder session instead of launching a fresh lander. The agent that wrote the change lands it, so it can explain what it did where a fresh lander lacked the context.

- One seam, `headless.mjs resumeBuilder` (from [a card pause stops its builder](2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md)), takes the card, the session and a brief. `landByBuilder` is the landing callers' one entry: the lander pass, a Merge tap's conflict (`finish.mjs landHeld`, which says why) and the PR rebase run. None of them knows how a session is resumed, so a later card can swap the seam for fresh agents, a compact before resuming or a sub-orchestrator.
- The session is the newest builder record on the card with a worktree and a session id, a past lander's or resumed session's included. The resumed brief is the lander's (or the rebase run's), starting a new record labelled Lander (or Rebase) so lines keep folding into the build's section and slot counting stays.
- Fresh fallbacks, as before: a Codex build, a build a session ran itself (no session on its record), a rebase run in another worktree than the session's, a resume whose launch fails.
- A resume whose process exits without `builder start` must not loop: `data/landers.json` marks the entry `resumed`, and the next pass launches a fresh lander for it (entry `fresh`).
- The thread says "Its builder resumes to fix it and land it." at a Merge tap's hand-off and "Builder resumed to land, session <id>." once the session continues. When no session can be resumed the fresh lander takes the same land, under the same hand-off words.

Follow-ups held on their own cards: compacting or measuring a session's context before resuming it, and moving all implementation to a sub-orchestrator or fresh agents ([a land waits for your Merge](2026-11-04-2100-a-land-waits-for-your-merge.md), [the board rebases a conflicting PR](2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md)).
