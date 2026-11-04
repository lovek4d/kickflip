# Triage runs once overnight on cards waiting on your answers

Supersedes [an idle board triages its Todo once a day when it changed](2026-11-03-1551-an-idle-board-triages-its-todo-once-a-day.md).

The owner, on #190 (11/04), kept auto triage but changed its target: when the cards on hand are waiting on grill questions the owner hasn't answered yet, triage them, merging questions across cards and deduplicating cards, as "an overnight thing, like middle of the overnight. It runs once. So it's just there ready for you in the morning". The #202 grill settled the rest.

- **When.** With `auto_triage` on, the board server sends one triage a night, from the middle of the hub's quiet hours (`quiet {start, end}` in `~/.claude/kickflip/settings.json`, 03:00 for the default 22:00–08:00, `hub/schedule.mjs` `quietMiddleOf`) up to their end. It goes only when at least two cards wait on open questions (work cards outside Done, `domain.mjs` `triageOf`), nothing builds (the pull's idle), usage isn't paused, and what the triage sees changed since the last one. A night whose conditions never hold before quiet hours end sends none.
- **A timer.** The board's Auto jobs run on board changes; the minute check also runs them while tonight's triage is due (auto-triage on and no `overnight-triage` for tonight), so the middle of the night needs no board change. settings.json is read on each check, since the owner edits quiet hours.
- **What it sends.** Topic `overnight-triage-<date>` ("Overnight triage <date>", the host day of the night's middle) and `overnight-triage {date, topic, cards}`, `cards` being the waiting cards' keys. As before, the pull waits for the session's reply, and `data/triaged.json {seen}` stays current until then so the triage's own merges don't read as a change. `seen` is each waiting card with its open count and when each open question was asked, then the Todo (`todoOf`), so a new or answered question, or a Todo change, lets the next night triage again.
- **Merging questions.** One survivor: the merged question goes on the newest of its cards by `created`, naming the cards it answers for in its context; the others are resolved "Replaced by <id>", and the session copies the owner's answer onto each card when it lands. The question store keeps one topic per question, so no "applies to these cards" field.
- **Folded in.** The old Todo hygiene (duplicates, cards a newer card covers, cards ready to close, stale deps) runs inside the overnight triage and no longer on its own. Questions it posts wait for morning by quiet hours' hold.
- **Later.** Proposing answers the orchestrator is confident of is follow-up #218.
- Board settings' toggle reads "Triage overnight".

Considered:
- triaging only when every available card waits on questions: a busy board almost never meets it;
- the hub waking the board at the midpoint: the board server already has a minute check, and the condition is the board's to judge;
- keeping the event name `todo-triage`: it now triages questions first, and the old name would mislead the session.
