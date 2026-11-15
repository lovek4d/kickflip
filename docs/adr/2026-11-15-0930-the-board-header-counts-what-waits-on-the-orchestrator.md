# The board header counts what waits on the orchestrator

T-299 asked that nothing sent to the orchestrator be lost or forgotten, and that the owner can see the queue: "a count that opens the ordered list". The queue already existed as `data/orchestrator-waits.json` (docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md), read only by the watcher. T-393 shows it on the board. The prototype (topic waits-list on T-299) drew three takes; the owner picked A, the header chip.

## Decision

- `/api/board` carries `orchestratorWaits`: the waits file's entries in its order (bumped cards first, then lanes top-down, then waits with no card), each `{key, ref, title, kind, since}`. The wake bookkeeping (`bumped`, `picked`, `pushed`, `next`) stays out, so a re-wake moves no change number. The page reads the file's order rather than sorting; it is the order the orchestrator is woken in.
- The board header shows a chip before the refresh, "N waiting" on a phone and "N waiting on orchestrator" from 900px, gone at 0. Tapping it opens a sheet, "Waiting on the orchestrator · N", one row per wait: the ref, the title (a triage or another board's question carries its event as ref and title), the kind in plain words ("sort the new task", "verify the builder's calls"; `ui-waits.js` WAIT_WORDS) and a live duration through `liveFor`. A card's row opens the card; a wait with no card opens nothing.
- Colour, by AGENTS.md's colour priority, from each wait's `since`: grey under the 15-minute re-wake (`REWAKE_AFTER`), orange past it, red past the 30-minute push (`ORCHESTRATOR_PUSH_AFTER`). The chip takes its oldest wait's colour; each row's dot takes its own.
- The chip and an open sheet repaint each half-minute, so the durations count up and the colour turns without a board change.
- A test reads every `kind: '<x>', since` in `board/domain.mjs`, and each event kind `eventWaits` keys its waits by (pr-review, review-answer, arch-review, slack-question), and fails when one has no words, so a new wait kind brings its words.

## Considered

- A section at the top of Todo (take B): seen only with Todo scrolled to the top.
- The count on the sidebar's board row (take C): hidden on a phone with the sidebar closed.
