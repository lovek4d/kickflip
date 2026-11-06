# One agent's status lines fold into one line with a caret

Status: accepted

A long build filled a card's thread with its status lines. Owner, on prototype collapse-lines-2 (question gh353-fold-2): take B, the agent and a count only.

`domain.mjs` `agentOfLine` gives each thread status line `agent`, `run` (the agent's record name) and `running`, since a stored status line has no agent id: the agent is the newest started of its kind of work (planner lines to planners, the rest to implementers) that was running at the line's time. A line no agent covers carries none.

`ui-threads.js` `foldStatus` replaces an agent's lines with one `<details class="msg calls status-fold">` at its first line's place, reading "<agent> · running|finished · N status lines" with the caret judgment calls use, and the lines inside. An agent with one line, and a line with no agent, draw as before. Folding is drawing only: the lines stay out of the message window and unread counts as before.

Not shown on the folded line: the newest status text (take A) or stalled/nudging; the card's own header carries those.
