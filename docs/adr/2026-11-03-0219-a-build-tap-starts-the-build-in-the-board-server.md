---
status: superseded in part by 2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark
---
# A Build tap starts the build in the board server

Superseded in part by [a card reads starting from its tap, with one dispatched mark](2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md): the tap's record is marked `dispatched: 'tap'`, not `tapped`, and the card reads "starting" from the tap, not "Waiting for orchestrator".

This supersedes in part [a Todo card that nothing blocks has Build](2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md), on what a tap does and what the session does, and extends [the board records what it knows, and commands make the rule calls](2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md) to the deterministic half of a build.

The owner's Build sends `card-build {key}` as before. The board server now does what `builder start --kind build --worktree` did for the session (`board/server.mjs`, `store.mjs` `startTappedBuild`):

- **Refusals first, in the owner's words.** Paused at the pause line ([work pauses at the pause line](2026-11-01-1710-work-pauses-at-the-pause-line.md)), held, blocked by an unfinished dep, or a prototype pick whose note waits on a confirm round ([a prototype answer with a note gets a confirm round](2026-11-01-1514-a-prototype-answer-with-a-note-gets-a-confirm-round.md)). `builder start` still makes each check itself; the tap's own check only words the reason for the card. A refused tap sends no event. The board writes "Couldn't start the build: <reason>" in the card's thread as a line of kind `build-refused`, and the Todo card shows it in its status line while it is the card's newest line other than a status line (`domain.mjs` `refusal`). The card stays in Todo with its Build.
- **The pick.** `builder pick`'s rule, Codex or Opus from the hub's Codex share and the pause line (`shared/usage-gate.mjs` `builderPick`).
- **The worktree.** The same one `builder start --worktree` makes, from the board's branch of its shared clone, or the kickflip clone's main for a board with neither a GitHub repo nor a plain git remote (`board/worktree.mjs` `boardWorktree`, which the CLI now calls too).
- **Building.** The card is marked building and gets the main builder record, of the pick's kind, keeping the worktree and marked `tapped`. It is in In Progress at once ([a card moves to In Progress only once building starts](2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md)), and its builder line reads "Waiting for orchestrator" until a status line arrives. That isn't a builder status line ([a builder status line is a phase and a short detail](2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md)): nothing is written to the thread, and the card renders it where the builder line goes. Stalled still counts from the record's start, so a session that never takes it up gets nudged.
- **The wake.** Once started, the server appends `card-build {key, ref, kind, reason, worktree}`, which wakes the owning session ([a board's session wakes when an event arrives, and live means its session runs](2026-10-30-1601-a-boards-session-wakes-when-an-event-arrives.md)). The session writes the builder's brief and launches a `kind` builder in `worktree`. It no longer runs `builder pick` or `builder start --worktree` for a tapped build.
- **The builder takes it up.** The builder's own first step is still `builder start <key> --kind build`, which the SubagentStop hook keys on. On an open `tapped` record it keeps the tap's kind and worktree and starts the record again at now, no longer tapped. Until its first progress line the card reads "Starting", as for any other start.

The Build button reads "Starting…" only while its event is sent, since the server answers once the build has started or been refused. The card's `starting` flag goes.

**The idle pull keeps its session step.** `card-pull` still only names the card ([an idle board pulls in its top Todo card](2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md)). The session decides whether a pulled card needs a grill or a build, which the board can't tell from its notes, and a build it chooses goes through `builder start --worktree` as before. Answered cards woken by `card-unblocked` start the same way. Neither is a card run ([only the owner or Auto-build starts a card run](2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md)), which is still only the owner's Serve or Build on a branch, or Auto-build.

The owner asked on #59: "Clicking build should not have to wait on the orchestrator. It should put it into the in progress lane and then set the build status to waiting for orchestrator if that is the case", then widened it: the deterministic half of a build moves into the board server, and the session's only job is the brief and the launch.

Considered:
- moving the card on the tap's event alone, with the session's `builder start` still making the record and worktree: the card would show In Progress for a build that could still be refused;
- the builder skipping `builder start` once the server made the record: the SubagentStop hook closes only records a subagent's own `builder start` made, so a builder that died would leave the card building;
- a separate wake event such as `build-started`: `card-build` already names the owner's tap, and now carries what the tap started;
- writing "Waiting for orchestrator" as a status line: it would read as the builder's progress in the thread and reset Stalled;
- the server also building pulled cards: a pulled card may need a grill first.
