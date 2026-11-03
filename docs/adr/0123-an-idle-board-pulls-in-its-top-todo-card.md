# An idle board pulls in its top Todo card

The owner asked on hub/INT-163 about "automatically pulling in todo items when idle", then on hub/INT-166 that it "should probably be an opt in per board setting", and settled take A of prototype `auto-pull`.

Answered cards already start on their own ([0053](0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md)), so what waits in Todo is mostly ungrilled: a grill only starts when the owner mentions the card.

- **Opt-in per board.** `auto_pull` in `board.json`, off when absent (`store.mjs settingsOf`), like Auto-merge ([0052](0052-auto-merge-is-a-board-setting-off-by-default.md)). Board settings shows it as "Pull in Todo cards when idle" in its own Todo section after Builds, and confirms before turning it on, since it spends usage without asking. `board.mjs settings set auto-pull on|off` sets it from the CLI, and every wake prints `setting auto-pull on|off`.
- **The board server decides.** A minute check beside the stalled-builder and pick-up checks (`board/server.mjs` `checkPulls`). The board is idle while no card has a running builder, Codex or Opus alike, and none waits in Orchestrator review. A card is pullable when it has Build ([0122](0122-a-todo-card-that-nothing-blocks-has-build.md)): an unstarted Todo work card that isn't held, has no unfinished dep and no Action needed; and, beyond that, it has no questions at all and no grill under way (`domain.mjs` `pullOf`). New cards are left to the session's sorting, and follow-ups to the owner's Build ([0034](0034-follow-ups-are-todo-cards-of-their-wave.md)). The top pullable card in board order goes, so a bump decides what comes next ([0019](0019-a-card-that-hasnt-started-can-be-bumped.md)).
- **What it sends.** `card-pull {key}` and a thread line, "Pulled in: the board was idle." The hub's wake brings a sleeping session up for the event ([0061](0061-a-boards-session-wakes-when-an-event-arrives.md)); there is no hub timer and no push ([0006](0006-pushes-only-when-something-waits-on-the-owner.md)). The session takes the card's next step: a grill when its notes leave something open, else a build.
- **One pull at a time.** The next pull waits until the pulled card stops being pullable: it got questions, a builder or a hold, or left Todo. `data/pulled.json` keeps the pulled card, and the event log covers a restart between the event and that write. A card is pulled again only after it stopped being pullable and became pullable again, such as after a hold.
- **Pause line.** The check sends nothing while `readUsageGate` reads paused, and `card-pull` joins the events watchers and the hub hold until reset ([0094](0094-work-pauses-at-the-pause-line.md)), so one sent just before a pause waits too.

Considered:
- the skill deciding on each wake: a sleeping session never wakes to decide, and an idle board is exactly when it sleeps;
- a hub timer per board: the hub's timers know nothing about lanes, and the board server already reads them every minute;
- idle as nothing at all in In Progress, or fewer than N builders: a card waiting on the owner's Ready or questions would keep the board from ever pulling;
- only grilling a pulled card, or building it from its notes with the recommended defaults: the first leaves a settled card waiting for a build, the second builds what the owner never settled;
- the toggle under Builds beside Auto-build (take B): pulling acts on Todo, not on builds.
