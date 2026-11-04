# The hub launches every agent from the card

Every build starts the same way. The board server launches the agent itself, headless, from the card's notes. This holds whether the owner taps Implement, a queued build starts, or Auto implement pulls a ready card. The `headless_builders` setting is gone, along with its Board settings row ("Builders launch headless"), with nothing in its place, and `settings set headless-builders`. This makes the path [builders launch headless](2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md) put behind a setting the only path. Card #206 (one-launch-notes.md).

**One launch path.** `handOff` in `board/server.mjs` launches every build `startTappedBuild` opened. Claude runs as `claude -p <brief> --permission-mode auto --model <pick>` in the card's worktree. A Codex pick runs as `codex exec --sandbox danger-full-access --cd <worktree> <brief>` (`board/headless.mjs` `agentArgs`; the binary is `KICKFLIP_CODEX`, else `codex`). The thread line reads "Builder launched on <model> in <worktree>.", with the log linked. `data/headless-builders.json` records each launch's kind, so a revived Codex build relaunches as Codex. No `card-build`, `card-pull` or `card-plan` event wakes the session.

**Planners launch from the hub too.** The board server launches the planner itself for any of these:
- A `grill-more` (the card's Grill).
- A `prototype-request`: the card's Prototype, or the owner's eye on one question.
- The idle board planning its top unready Todo card: a prototype when the card is prototyping, a grill otherwise.

The record opens `dispatched: 'hub'` (`store.mjs` `startPlanner`). A planner already open on the card launches nothing more. The planner runs in the board's repo folder, on Claude Opus for a grill and Claude Sonnet for a prototype. Its brief (`plannerBrief`) points it at the card's notes and thread, `docs/adr`, `CONTEXT.md` and the linked cards, and has it follow the grilling or prototype skill. For a prototype round on one question, the brief also carries that question, the owner's note and their choice. The thread line reads "Planner launched on <model> in <folder>.". The planner prompt itself is #187's to engineer.

**A failed launch goes back to Todo.** With no session to fall back on, a launch that throws reopens nothing: `abandonLaunch` closes the record, clears building and writes "Couldn't start implementing: the launch failed (<error>). Tap Implement to try again." in the thread. That is take A of prototypes/one-launch. A planner whose launch fails closes its record with "Couldn't launch the <kind> (<error>)." A builder that dies twice with the build unfinished keeps its card In Progress. Its thread gets "Its builder exited twice with the build unfinished; it reads Stalled once 30 minutes pass without progress." The stall alarm brings it to the session. Moving the card back to Todo here would throw away a worktree that holds work.

**Ready is checked everywhere.** `item set --state ready` refuses a card without a size, without a notes file, or whose notes don't name every answered question's id. It does this on every board. Marking a card ready also resolves those answered questions ("Recorded in the card's notes"). Before this, only a builder's start resolved them, so a ready card with answered but unresolved questions sat in Todo, because the pull refuses such a card (#191). Cards already ready stay as they are until next touched.

**Orchestrator review is the 4th bar.** The phases are reading, building, testing, checking and landing. A card in Orchestrator review now fills four bars, with checking current. It no longer fills all five ([every In Progress card shows its phase bars](2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md) drew all five for #165). A rebase conflict and the lander show on the 5th bar.

**A planner opens in its request's millisecond.** The board server starts a planner in the same request that logged its `grill-more` or `prototype-request`, so the record's start can equal the event's time. `planningOf` in `board/domain.mjs` therefore counts a planner started at or after the request as answering it.

**What the orchestrator still does:** it answers or defers builder asks, verifies judgment calls, puts deferred asks to the owner, triages and reviews PRs. It no longer briefs, launches or lands agents. `builder start --dispatch` stays for any agent the session launches itself.

The owner, on #203's gh203-turn-on: "It should always be headless builders, I think, even if the orchestrator is kicking it off … Like this should be dry." On gh206-planners: "we should be leaning on the ADRs and context so the orchestrator doesn't strictly need to handle the details like this." On gh206-codex: the hub launches Codex too, with a model-agnostic adapter as a follow-up. On gh206-setting: the Ready check applies everywhere. On gh206-answers: Ready resolves the questions. On gh206-bars: review is on the 4th bar.

Follow-ups: #187, the planner prompt; #224, one adapter for Claude and Codex; #227, nudging the orchestrator when a card goes stale.

Considered:
- **A read-only settings line saying builders always launch headless.** The owner picked nothing in the setting's place.
- **Falling back to the session when a launch fails.** That keeps a second path alive for the rarest case. The card back in Todo with the reason is what the owner picked.
- **Moving a twice-dead build back to Todo.** That loses a worktree with work in it. The stall alarm already brings it to the session.
- **Running planners in a worktree.** A planner writes only through the board CLI and the prototype pages, so the board's repo folder is enough.
- **Codex in its default sandbox.** Codex's default sandbox can't write outside the worktree, but a builder must run the board CLI on the site's data.
