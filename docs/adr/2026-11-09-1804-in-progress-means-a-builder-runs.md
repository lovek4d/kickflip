# In Progress means a builder runs

#492. The owner: "replying to an in review should not automatically move it to in progress, only if the orchestrator decides to start a builder for it. in progress should be kind of analogous to running background builder agent (excluding prototype/grill planner agents in todo)".

**The rule** (domain.mjs `workItem`). A card moves to In Progress when a builder starts on it. Two cards that sat In Progress with nothing running now wait in In Review on the orchestrator until it starts one:

- **A reopened card nothing has built since its reopening.** An owner message or question on a Done or merged card reopens it into In Review, not In Progress. While the owner's reply has no answer from Claude it reads Next "Your reply waits on the orchestrator", no new phase, and joins the orchestrator's waits as `reply` ("Act on the owner's reply") from the oldest unanswered message. Once Claude answers it waits on the owner's Done as before ("Tap Done once it is settled", or its owner step). A reply on a card already In Review waiting on that Done stays there the same way. A Next the orchestrator set after the reopen keeps the card off the owner's Done, as [a Next set after a reopen keeps the card in In Progress](2026-11-07-1300-a-next-set-after-a-reopen-keeps-the-card-in-progress.md) built it, but in In Review reading that Next. A build agent started after the reopening takes the card to In Progress, and it stays there once that run ends.
- **A ready PR whose CI fails**, or a red draft on a board that skips the draft, with no builder on it: In Review, Next "Fix the failing CI", with no wait and no phase. A fix builder takes it to In Progress.

The settle pass writes "Moved to In Review: a message or question reopened it" for a Done card that reopens, and the In Review move's usual why (its Next) otherwise. A reopened card in In Review sorts by its reopening.

**What stays as it was.** Grill, prototype and visual planners never put a card In Progress ([a card moves to In Progress only once building starts](2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md)). A started card whose run stopped, stalled or ended with a Next stays In Progress ([a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md)); so does a hand-back waiting on the orchestrator's check (phase checking) and a paused build, blocked, held, usage-paused or bumped out ([a card pause stops its builder at its next stopping point](2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md)). The owner chose each of these in the grill. Ask cards keep their own lanes; T-2 places a replied-to ask.

Considered:
- moving every started card with nothing running to In Review, which the owner turned down: a stopped or stalled build stays In Progress;
- a new In Review phase for a reply waiting on the orchestrator, turned down for a Next line.

Supersedes in part [a message or question on a Done card reopens it until the owner's Done](2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md) (a reopened card sat In Progress until Claude answered), [a Next set after a reopen keeps the card in In Progress](2026-11-07-1300-a-next-set-after-a-reopen-keeps-the-card-in-progress.md) (it now waits in In Review), and [the lane follows who acts next](2026-10-29-1639-the-lane-follows-who-acts-next.md) (a ready PR with red CI sat In Progress).
