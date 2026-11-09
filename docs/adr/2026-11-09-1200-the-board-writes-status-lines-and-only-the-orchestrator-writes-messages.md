# The board writes status lines, and only the orchestrator writes messages

Status: accepted (#426)

The board's own thread lines (holds, launches, blocks, refusals, "Pulled in: an implementer slot was free.") were plain `{who: 'claude', text}` lines, so the thread drew them as Orchestrator messages. The owner asked for a seam: a line the board writes is always a status line, and a message bubble titled Orchestrator is only ever the orchestrator's own words (or a person's, or a comment brought in from GitHub or Slack).

## Decision

- The store has two thread writes. `appendStatus(site, key, kind, inputs)` writes a status line `{who: 'claude', kind: 'hub', line: <kind>, text}` of a kind in `board/hub-lines.mjs` `HUB_LINES`, which holds each kind's mark and its words. `appendMessage` writes a message. The owner's button taps keep their command lines. `appendThread` is gone, and `board-threads.test.mjs` fails on any code that appends a plain line to a thread file any other way.
- Words the orchestrator wrote stay a message (`thread --text`, `item set --done --text`, `--from-ask --text`, `relate-ask --summary`, `item stall`, `build --asked`, a builder's `done --text`). Words the board writes become a status line, and that includes a close the board makes (a merge, a PR closed, an ask moved, an owner check that passed, a branch merged or gone, an architecture review's findings settled). `setItem` takes `closing: [kind, inputs]` for those. The `merge` command writes the board's merged line, then the orchestrator's after-approval and manual-step words as a message.
- Status lines have no label. Being a status line already says the board wrote it.
- Marks: Held (pause) for holds, waits and stops, Resumed (play) for resumes and unblocks, a new Blocked (circle with a bar) for blocks and can't-start-yet, a new Fault (warning triangle) for failures, the request icons for launches and asks, move for moves, the done check for closes.
- A fault line is red, counts as unread and freshens the queued push. Every other board line is quiet: not unread, no push. Status lines still count wherever a plain Claude line counted before (it answers the owner's message before it, it ends a merging card's wait, it is a write on the card), except where the reader now matches the kind instead of the text: the lander handoff and the land wait leave a card merging, and a build refusal is not a write.
- The host-busy hold reads "Host is busy, work will resume when the host recovers". A planner held by a usage pause reads "The <kind> waits and starts when the hold lifts." without the pause's reason, which the Hub page shows.
- Limits are 100 characters for a status line and 2000 for a message. Both are refused at write and never cut. The message refusal tells the orchestrator to rewrite it shorter or put the detail in an HTML page (`visual add`, or `--link`) and link it. Commands that close a card with a message check its length before they change anything. A comment brought in from GitHub or Slack is kept whole.
- `hub-lines.test.mjs` runs every kind with its longest real inputs (each kind's `longest` names its bounded ones) and every other input 5000 characters long, and fails if any line goes past 100. A kind that takes unbounded text (an error, a path, a title) fits it into the line itself (`fit`): paths read from `~`, then by their last part, then the text is cut with an ellipsis. So a long outcome is caught by the test and never at runtime.
- Lines already stored stay as they are (the owner, on #440: "Whatever leaves less cruft"). Readers no longer match the old texts (`LANDER_HANDOFF`, "Waiting for", `kind: build-refused`).

## Consequences

- A launch's helper line drops its task ("Asked for helper tests, which writes code"), since the task is the builder's words and unbounded.
- A try-run failure is one line, `<Serve|Build> failed (exit N): <one reason>`: the keychain hint first, else the error, else the signal, else the log's last line. It no longer shows the last five log lines.
- `shared/usage-gate.mjs` `MACHINE_HELD_LINE` is gone. The busy-host refusal text is unchanged.
