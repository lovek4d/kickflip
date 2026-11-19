# Red CI on a card's PR launches its builder

#1110. Since #1098 `builder start` refuses a build the board didn't launch, yet SKILL still told the orchestrator to start a builder by hand on a PR with red CI. The owner: reopening a Done card is the orchestrator's judgment, and red CI is the one contained trigger left that is mechanical, the failing check being the whole brief.

**The rule** (domain.mjs `fixesDue`, runs.mjs `launchFixes`). A work card whose open PR has red CI and no builder on it (In Review reading "Fix the failing CI": a ready PR, or a draft on a board that skips the draft), not blocked and with no reply of the owner's unanswered, gets its builder launched by the board's launch pass, as a pull launches a ready card. The run starts dispatched `hub`, labelled **Fix CI**, in the worktree the card's last build kept or one made from the PR's branch, and the card records `fix_run {pr, fix, failing, at}`. Its brief is the builder's, with the PR's failing checks as its Next and the finish pushing to the PR's branch, as the rebase run's does. A thread line says it started. The card takes the slot it already holds, since In Progress counts the card, not the run.

**Once per red head.** `data/fixes.json` keeps, for each card, the PR's head and its sorted failing checks a run was started for. The same pair never gets a second run, so a fix that leaves CI red waits for the orchestrator; a new push, or another check failing, is a new pair. A start that is refused leaves a fault line and keeps its entry. A run whose process dies is relaunched by the ordinary builder revival, and `fix_run` ends when the run pushes to the PR, or when any other main build starts.

**What stays the orchestrator's.** A card moved out of Done, and a reviewer's "changes requested", stay judgment calls. A red draft on a board that doesn't skip the draft stays the owner's. A failure the change didn't cause (a flake, main's own broken test) is the builder's call "Not caused by this change", which hands the card back.

The hub's check now carries each PR's failing check names to the board (snapshot.mjs `prViewOf` passes `failing`).

Considered:
- launching on a card moved out of Done as well, which the owner turned down as judgment;
- a rerun of a flaky check before a builder: left to the builder, which reads the log and records a call;
- the fix run as a lander-style record in its own file, as the rebase run has: a plain builder record is enough, since its revival, summary and hand-back are a build's.
