# Only a run that changes code moves an In Review card

#379, split from #324. The owner: "Rebase and conflicts in review, going back to make code changes outside of that should bump to in progress again." Asked which runs count (gh379-runs-lane), they answered: "Only code changes move it: install runs and landers both stay in In Review."

**The rule** (domain.mjs `laneOf`, `changesCode`). A run that can change the card's code moves a card with an open PR or a verified branch held for Merge to In Progress while it runs and while its hand-back waits on the orchestrator: a fix builder sent back after review, a reopened card's build, a helper. A rebase run keeps the card In Review, as [the board rebases a conflicting PR with a headless run](2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md) built it. Two runs change no code, and leave such a card In Review:

- an install run (`--kind install`), which builds the app from the branch, and
- a lander (a builder record labelled `Lander`, headless.mjs `landerBrief`), which lands a verified build, running or handed back. This includes the lander a held branch's Merge tap starts (finish.mjs `landHeld`). Until now that lander moved the card to In Progress.

A card with no open PR and no held branch is In Progress while any run works on it, these two included, as before: nothing else would place it.

**What the card shows.** The run's status line, in In Review's colour ([every run takes its lane's colour](2026-11-06-0145-every-run-takes-its-lanes-colour.md)). In Review draws no phase bars, so a lander there has no landing bar.

**Left for later.** The owner asked whether In Review should be the testing, landing and rebase phase, so a card leaves In Progress once its checks pass. That is a separate card, part of the lane progress step audit.
