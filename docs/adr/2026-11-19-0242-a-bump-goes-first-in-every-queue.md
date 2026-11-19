# A bump goes first in every queue

Status: accepted (owner's answer t744-preempt, "No: a bump goes ahead of every waiter but never stops running work", 11/18)

Card #1085 (T-744). The owner asked to audit the bump: "the bump should push past all queues we use, such as the test
waits etc." The audit found the land and test-slot queues put the latest bump first while every other queue put the
earliest first; the host-busy hold, queued planners, held builder launches and paused-build resumes ignored bumps;
and the pull put cards blocking an In Progress card ahead of bumped ones.

Supersedes in part [a bump marks the priority through every lane](2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md)
("A busy host holds a bump too"), [the orchestrator stops the board's own runs](2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md)
and [land test runs take turns on the host](2026-11-16-0700-land-test-runs-take-turns-on-the-host.md) (the latest bump
ahead), and [a blocked In Progress card takes no slot](2026-11-16-0300-a-blocked-in-progress-card-takes-no-slot.md)
(blockers ahead of bumps).

## Decision

- **One order everywhere: bumped first, the earliest bump first, then each queue's own order.** `domain.mjs byBump`
  is the one sort. It orders the pull (bumped cards now go ahead of the cards blocking one In Progress), paused-build
  resumes, the planners a hold queued, briefed planners, visual agents and reviewers, landers, rebase runs, reruns,
  helpers, held builder launches and lost launches. The land queue and land test slots (`worktree.mjs rank`) take the
  earliest bump first too, so a bump again moves a card behind the earlier bumps, as on the board.
- **A bumped card's launch passes a busy host.** `heldFor(gate, kind, bumped)` holds a bumped card's launch for a pause
  (usage, Pause board, Pause hub) but not for a busy host. Each launch pass walks its runs in bump order and stops at
  the first one a hold keeps, so a busy host lets the bumped ones through and holds the rest; a pause still ends the
  pass. `builder start` reads the card's standing bump (`runs.mjs heldOn`) the same way, and a bumped verified card's
  land step reads the bumped holds (`landHeld.bumped`). A bumped card's land runs its tests without waiting for a busy
  host (`worktree.mjs passTests`), reading the bump it queued with. With nothing left for a busy host to hold on a
  bumped card, the "held while host recovers" footer word is gone.
- **No preemption.** A bump goes ahead of every waiter but never stops running work: a running land, test run or
  build carries on.
- **PR reviews are unchanged.** They are PRs, not cards, so there is no bump to order them by.

## Considered

- Letting a bump stop running work so the bumped card goes now: the owner's answer was no. The owner's note on
  Implement asks for a separate mechanism, later, by which the orchestrator can stop all other work to push one task
  through.
