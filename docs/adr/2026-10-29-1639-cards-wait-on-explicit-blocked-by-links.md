---
status: superseded in part by 2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent
---

# Cards wait on explicit blocked-by links

Superseded in part by [a follow-up is a work card with a Parent](2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md): the open card lists its unfinished deps in a Blocked by row of card labels, and a blocker lists the cards that Waits on it. The deps and what they gate are unchanged.

Queued work names what it waits on in its `deps`. A card is blocked while any dep hasn't reached Done (`done`, `merged` or `dropped`, or its PR merged or closed). Its card shows a "Blocked by INT-10" chip for each unfinished dep on its last line, linking to that card, and a "Ready to start" chip among its other chips once none is left. A card that reached Done itself shows no Blocked by chip, even when it closed before a dep. An unstarted blocked or ready card sits in Todo; a started one keeps its lane ([a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md)).

`board.mjs item set <key> --status building` refuses while a dep is unfinished in its wave file, naming the blockers. There is no override: to start early, change the card's `deps`. When `--status done`, `merged` or `dropped` finishes the last dep of a waiting card, it prints `unblocked: <key>` and appends one `card-unblocked {key}` event to the site, waking its owning session whoever ran the command. Repeating a finished status emits nothing. Held cards also get the event; the session starts each unheld card straight away and leaves held cards for the owner to resume.

`item set <key> --next <text>` refuses text naming another unfinished card on this board unless that card is in its `deps`, naming the key and suggesting `--deps`. Bare and wave-qualified stored ids and displayed refs count; finished cards may be named freely. A command supplying both `--next` and `--deps` checks the new deps.

Queued cards sat for minutes after their blocker finished, because nothing told the session a card could start.

Considered:
- the session checking the queue on its own timer;
- `deps` as a display hint only, with no refusal.

The owner asked for strict blocked-by links that cascade when the blocker finishes (in INT-14's ask).
