# The waits sheet lists one row per card, for what the orchestrator owes now

T-459 (#867). The header's Waiting on the orchestrator sheet (docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md) drew one row per wait, so one card read as "2 waiting": T-458 had a fresh investigate wait and a limbo wait in the same second, right after item triage. Limbo means the card owes nobody anything (docs/adr/2026-11-15-1600-a-card-owing-nobody-or-with-the-owners-word-last-waits-on-the-orchestrator.md), so it cannot sit beside a wait the orchestrator owes. The owner answered that the sheet lists only the steps the orchestrator owes now, that limbo is a grey row only when nothing else waits on that card, and that each row's age dot goes, its step text taking the colour.

## Decision

- Limbo goes only on a card with no other wait: `orchestratorWaitsOf` drops it when the card holds any other wait, and `waitFirst` drops it when an intake or screen wait joins. It also skips a card blocked by a task or a date (`it.blocked`): that card owes its blocker. A card with a live planner, prototype or visual agent was already skipped.
- `waitTone` keeps a limbo wait grey at every age: it is the backlog, not a step running late.
- The page groups `/api/board`'s `orchestratorWaits` into rows (`ui-waits.js` `waitsRows`), keeping the file's order of each card's first wait. A card's row is its oldest wait still listed, with "+N more" for the others. A checked build's land is the lander's job, so a `checking` wait is no row. An investigate wait is the card's row only while nothing else waits on it. A wait with no card is keyed by its event, so each triage, PR review, review answer, architecture review, Slack message and board ask is its own row.
- The chip and the sheet's title count rows, not waits.
- No dot: the row's step and its live duration take the row's tone (grey, orange from 15 minutes, red from 30).
- `orchestratorWaits` and `data/orchestrator-waits.json` still hold one entry per wait: the watcher wakes the orchestrator for each.

## The waits, as the sheet words them

Each kind's words in `WAIT_WORDS` read as the step the orchestrator owes, short. An example row is ref, title, then the step.

| Kind | Step | Example row |
| --- | --- | --- |
| intake | sort the new task | T-501 Copy the hook line · sort the new task (2m) |
| ask | answer the ask | T-470 Split the lander · answer the ask (6m) |
| answer | act on the owner's answer | T-459 Waits sheet audit · act on the owner's answer (1m) |
| reply | act on the owner's reply | T-450 Copied Slack reply · act on the owner's reply (4m) |
| review-answer | act on the held review's answer | PR #812 Post answered on the held review of PR #812 · act on the held review's answer |
| unblocked | act on the ended block | T-468 Builder pick · act on the ended block (3m) |
| brief | write the planner brief | T-450 Copied Slack reply · write the planner brief |
| screen | screen the grill's questions | T-462 Lander slots · screen the grill's questions (8m) |
| grill | start the grill | T-466 Board asks · start the grill (16m) |
| prototype | draw the prototype | T-433 Header chip · draw the prototype (20m) |
| unasked | post the planner's question | T-440 Limbo audit · post the planner's question (5m) |
| visual | place the visual's page | T-450 Copied Slack reply · place the visual's page (2m) |
| staging | look over the staged task | T-459 Waits sheet audit · look over the staged task (1m) |
| calls | verify the builder's calls | T-489 Header waits · verify the builder's calls (12m) |
| recheck | recheck the ready task | T-468 Builder pick · recheck the ready task (7m) |
| refused | sort out the refused build | T-471 Usage hold · sort out the refused build (31m) |
| stale | find out why it stalled | T-455 Phone sheet · find out why it stalled (45m) |
| unowned | set what happens next | T-447 Done summary · set what happens next (9m) |
| triage | run the overnight triage | 2026-11-16 Overnight triage 2026-11-16 · run the overnight triage |
| pr-review | review the pull request | PR #812 Review asked on PR #812 · review the pull request (3m) |
| arch-review | run the architecture review | T-480 Architecture review of kickflip · run the architecture review |
| slack-question | answer the Slack message | Slack · Pete Pete wrote in Pete's Slack review thread · answer the Slack message |
| ask (board ask) | answer the ask | /learn · T-12 Which port does the page take? · answer the ask (1m) |
| investigate | investigate the task (alone only) | T-458 Fix the arrow · investigate the task |
| limbo | ask Implement, ask questions or close it (grey, alone only) | T-412 Sidebar folds · ask Implement, ask questions or close it (2h) |
| checking | not listed: the lander lands it | — |

`recheck` read "recheck the ready card"; it now says task, as the rest do.

## Considered

- Grouping on the server, in `orchestratorWaits`: the watcher needs each wait to wake on it, so the file keeps one entry per wait and the page groups.
- Naming each other kind on the row instead of "+N more": longer, and the open card shows every wait.
- Keeping the dot, moved before the text: the owner chose to drop it.
