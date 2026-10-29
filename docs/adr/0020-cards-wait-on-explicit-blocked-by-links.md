# Cards wait on explicit blocked-by links

Queued work names what it waits on in its `deps`. A card is blocked while any dep hasn't reached Done (`done`, `merged` or `dropped`, or its PR merged or closed). Its card shows a "Blocked by INT-10" chip for each unfinished dep on its last line, linking to that card, and a "Ready to start" chip among its other chips once none is left. An unstarted blocked or ready card sits in Todo; a started one keeps its lane ([0049](0049-a-started-card-never-returns-to-todo.md)).

`board.mjs item set <key> --status building` refuses while a dep is unfinished in its wave file, naming the blockers. There is no override: to start early, change the card's `deps`. `--status done` and `--status merged` print `unblocked: <key>` for each waiting card they unblocked, and the session starts each one straight away.

Queued cards sat for minutes after their blocker finished, because nothing told the session a card could start.

Considered:
- the session checking the queue on its own timer;
- `deps` as a display hint only, with no refusal.

The owner asked for strict blocked-by links that cascade when the blocker finishes (in INT-14's ask).
