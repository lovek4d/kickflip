# A moment's rule lives in its wait's Next text

What the orchestrator does at a moment (a staged task, a builder's ask, a hand-back's calls, the owner's reply) lives in the Next of that moment's wait in `board/domain.mjs`, the text its `waits` line prints, not in SKILL.md. The wait is what the orchestrator reads at that moment, on every board; SKILL.md is read once and kept as background. The owner (T-154, 11/14): "Maybe I'm curious why it has to be in both skill and wait?", then "spin out another ticket to audit what can leave the skill and go to waits where that makes more sense" (T-373).

The audit went through SKILL.md's per-moment rules against the Next texts:

| Moment | Moved into the wait's Next | Left in SKILL.md |
| --- | --- | --- |
| Watch step, every wait kind | Its how-to (a sentence per kind, each copying or extending a Next) | The kinds named, the `reply` wait's end rule and log, `limbo` last, event-id waits surviving a dead session |
| `staging` | The checklist: no open or merged task covers it or overlaps its files, deps linked, related answers agree, size and model fit, nothing left for the owner; `--size` on ready | Why staging is where the board is judged (freshest before the build), the ready line's 100-character refusal |
| `intake` (an Implement ask) | The same checks before ready; "check them, don't hunt" on the likely-related list | Why triage comes before investigation, what `item triage` posts |
| `ask` (a builder's) | `builder answer` / `builder defer` with the ask id, when each fits, never the owner mid-build | The blocked-only rule, deferral as a "Question:" call |
| `calls` | `builder calls`, answering or sending back with `builder resume`, the owner question for a conflict or a deferred ask, `builder verified`, never redoing it | What `builder resume` does, what `builder verified` finishes |
| `reply` | Answer it in the thread, or act and let the action's line answer it | Which lines end it, the limbo log |
| `screen` | Settle only what notes, thread, merged code or another task answer, never the prototype question | — |
| `brief` (prototype) | Each prototype, and each owner request owed, is its own round | Where the brief goes, what launches |
| `stale` review | Why it may be stale, re-ping silent reviewers once in Slack, one thread line, the owner only for a decision | The daily re-wake |
| `limbo` | `reply <key> --implement` | — |
| `unblocked` | A thread line ends the wait | — |
| `refused` | Fix what refused it and start it, or say on the task why it waits | — |

Already in both, so only SKILL.md's copy went: `recheck`, `grill`, `prototype`, `unasked`, `visual`, `unowned`, `checking`, `investigate`, `triage` and the event-id waits (`pr-review`, `review-answer`, `arch-review`, `slack-question`, another board's `ask`).

Stays background, outside any one moment: the board's mechanics (lanes, pull, phases, refusals), why each rule exists (the ADR links), and the builder's side of judgment calls and asks.

`bin/event-lines.test.mjs` still checks the Watch step names every wait kind; `board/wait-next.test.mjs` checks each moved rule is in its wait's Next. The calls wait appends its how-to to the card's Next ("Verify the builder's judgment calls", "Answer the builder's questions"), which the card itself shows unchanged.
