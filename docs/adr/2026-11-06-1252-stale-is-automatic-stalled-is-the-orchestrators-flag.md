# Stale is automatic, stalled is the orchestrator's flag, both in the footer status

Card #378, split from #327. The owner (gh327-cap, 11/06): "stale when there hasnt been updates, but not stalled until the orchestrator decides it, and then just make sure the orchestrator is made aware of stale items ... and the orchestrator cant restart it, in which case it should get explicitly flagged by orchestrator as stalled (red, in the same place of green ready in todo, and actually stale can also go there in gray) which frees up the slot but also leaves that item dead until the user checks on it." Answers on the card (11/06): every recommendation, with the notes below, and take A of the prototype, plain words after the time.

## Decision

- **Stale is the board's reading, on signals it already checks.** What the board called stalled is now stale everywhere: `builder.stale` (`domain.mjs builderOf`, `BUILDER_STALE_AFTER`, 10 minutes of silence for an untracked run, at once for a gone one), and the `stale` wait kind on the orchestrator's list. A review more than seven days in review is stale too, and stays In Review: the Stale lane is gone. A card reads `stale` for either, never once Done.
- **The footer status.** The words after a card's time ("10:26 · held · blocked by #53 · Action needed · ready"), named in CONTEXT.md, end with a red "stalled" or else a grey "stale" (`ui-cards.js timeLine`).
- **No nudge.** A stale run's status line goes grey, its dot still, and is no button: no tap, no confirm, no `builder-nudge` event. The orchestrator is already told by its stale wait and reviews the lanes; the owner who wants it sooner posts in the card's thread (owner, gh378-line: "Drop the nudge logic ... Simplify that away").
- **A stopped build stays a wait on the orchestrator.** A run the orchestrator stopped reads its stop's words, plain, and is a `stale` wait, as before; only the flag below makes a card stalled.
- **Stalled is the orchestrator's flag.** `board.mjs item stall <key> --reason "<why>"` (`stop.mjs stallCard`) writes `stalled {reason, at}` on the card's wave entry, marks each open build record stopped so nothing relaunches it, stops its board-launched run as `builder stop` does (nothing to stop when it is gone), keeps its worktree, and writes "stalled by orchestrator: <why>" in its thread. The card stays in its lane, red "stalled" in its footer status, with no wait on the orchestrator, and `pullOf` counts none of its agents, so it frees its implementer slot while its record stays open.
- **The owner is told once.** A stalled card's Action needed is "stalled: <why>" (`ACTION_KIND.stalled`, ahead of every other kind), so it has a Needs you line and one push, sent at once like a question.
- **A message clears it.** Any owner message on the card (`item-message`) clears the flag in the board server, so the message reaches the orchestrator on its direct line and the card waits on it again as a stopped build. There is no tap on the red word and no Start again button (owner, gh378-clear: "No tap logic needed, rely on thread"). The thread's Send, or Reply, is the orange control that clears it (`BUTTON.reply`), as every Action needed has one.

## Considered

- Keeping the Stale lane beside the grey footer word: two places saying the same thing.
- Closing a stalled card's records to free its slot: the board would then read it as unowned and wait on the orchestrator, which is what the flag ends.
- Chips, or the reason under the title (takes B and C).
