# A builder stalls after 10 minutes without a progress line or transcript movement

A running builder, lander or planner reads Stalled once 10 minutes pass with neither a progress line nor a change to its Claude transcript (the newest `.jsonl` in `~/.claude/projects/<worktree path, / and . as ->`). This replaces the 30-minute rule on progress lines alone.

Progress-line gaps reach past 10 minutes (28 of 365 were longer), so a 10-minute rule on lines alone would raise false alarms; a transcript gains an entry for each message and tool result, and one `stat` reads it. A record without a worktree, or a worktree with no readable transcript, falls back to progress lines alone. CPU time and file changes were left out: the first needs the whole process tree, the second misses reading and test phases; a log file doesn't grow in `claude -p` text mode.
