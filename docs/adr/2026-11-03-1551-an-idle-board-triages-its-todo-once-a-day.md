# An idle board triages its Todo once a day when it changed

The owner asked on #74 for a second idle job beside the pull ([an idle board pulls in its top Todo card](2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md)): "triaging the to-do periodically while there's nothing else going on", for duplicates and cards that are ready to close, as the 11/03 dedupe did by hand. The #74 grill settled every pick on its recommended option.

- **Opt-in per board.** `auto_triage` in `board.json`, off when absent (`store.mjs settingsOf`). Board settings shows it as "Triage Todo when idle" in its Todo section under the pull toggle, with no confirmation. `board.mjs settings set auto-triage on|off` sets it, and every wake prints `setting auto-triage on|off`.
- **The board server decides when.** The minute idle check (`board/server.mjs` `checkIdle`) runs the triage, then the pull. A triage is due when the board is idle by the pull's definition (`domain.mjs` `pullOf`), Claude isn't paused, Todo has cards, Todo changed since the last triage, and the last triage wasn't on the same host day. Todo is read as each Todo card's key, title and deps (`domain.mjs` `todoOf`), so a card added, dropped, renamed or relinked counts as a change.
- **What it sends.** The server declares topic `todo-triage-<date>` titled "Todo triage <date>" in `owner.json`, then appends `todo-triage {date, topic}`. The hub's wake brings the session up, the watcher marks the event working, and the pause line holds it like the pull's ([work pauses at the pause line](2026-11-01-1710-work-pauses-at-the-pause-line.md)).
- **Triage before the pull.** While the latest `todo-triage` has no reply, the pull waits. The session replies once it has done the triage.
- **Its own edits don't count.** Until that reply, `data/triaged.json` keeps the Todo it last saw current, so the links and merges the triage makes don't read as a change and trigger another triage the next day. The event log says when the last triage went out, so a restart between the event and the marker write doesn't send a second one that day.
- **The session judges.** Which cards are duplicates, covered, ready to close or have stale deps is the session's work. It links Related cards and merges clear duplicates (going with the newer card) itself. Anything that closes a card, or anything unclear, becomes one question per finding on the dated topic, all added in one `question add` so the topic pushes once. The rest uses commands the board already has: `item set --related`, `item set --status dropped`, `question add` and `reply`.

Considered:
- a `triage` CLI command recording findings: the existing commands already cover each finding, and a dated topic is all the grouping the owner asked for;
- at most once per 24 hours: a calendar day matches the dated topic, so each day has at most one;
- fingerprinting card notes too: a grill's notes edit would read as a Todo change every day a grill runs, and duplicates mostly show up as new or renamed cards;
- triage in the same toggle as the pull: the owner picked its own toggle, since one spends usage building and the other only asks.
