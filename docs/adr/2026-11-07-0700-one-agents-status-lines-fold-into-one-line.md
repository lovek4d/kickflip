# One agent run folds into one line with a caret

Status: accepted

A long build filled a card's thread with its status lines. Owner, on prototype collapse-lines-2 (question gh353-fold-2): take B, the agent and a count only. After it landed the owner said "This feels incomplete": the started and finished lines still sat outside the fold, planner status lines didn't fold, and it showed open.

A status line is written with `run`, the started time of the agent record it was written under (`store.mjs` `statusToThread`), and `domain.mjs` `threadOf` gives the agent's started and finished lines the same `run` and an `agent` name, so a run groups exactly. A line from before lines carried a run id falls back to `agentOfLine`: the newest started agent of its kind of work (planner lines to planners, the rest to implementers) that was running at the line's time. A line no agent covers stays a plain line. Planners include grill, prototype and visual agents.

`ui-threads.js` `foldStatus` replaces a run's lines with one closed `<details class="msg calls status-fold">` at its started line's place. Finished it reads "<agent> · finished · N status lines"; running it reads "<agent> · running · <newest status text> · N status lines". Expanding shows the started line, the status lines and the finished line. Orchestrator and owner messages never fold. Folding is drawing only: the message window and unread counts are unchanged, since these lines were never messages.

Not shown on the folded line: stalled/nudging; the card's own header carries those.
