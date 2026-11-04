---
status: superseded in part by 2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls
---

# The CLI and board server do the board's housekeeping

Superseded in part by [the board records what it knows, and commands make the rule calls](2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md): the board server sends every Action needed push, so `question add` and `question confirm` no longer push, and the reminder event is gone.

A step every session takes the same way, after the same trigger, belongs in `board.mjs`, the watcher or the board server, not in SKILL.md for the session to remember. The session keeps the judgement calls.

- **Working marks.** The watcher (`bin/wait-events.mjs`) writes a mark to `data/working.json` for each `ask`, `item-message` and `wave-triage` event it prints. `board.mjs working` is gone ([a pending ask or thread message can be deleted or edited, and a pending ask bumped](2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md), [any work on a card starts it](2026-11-02-2000-any-work-on-a-card-starts-it.md)).
- **Closing lines.** `item set --status done|dropped` and `followup done` on a site refuse without `--text`, which becomes the card's last thread line in the same call; `--status merged` writes "Merged PR #n." unless `--text` is given. `land <key> --site <route> --text` refuses first what closing would refuse, then closes the card as done once it lands, so done no longer comes before land. `item set --from-ask` needs `--text`, the item's first thread line, which clears its "Working on it".
- **`checked`** takes `--every` from the polling window now when it is left out.
- **Question pushes.** `question add` and `question confirm` push their questions themselves: one action push `--now`, titled from the card or topic, opening Waiting on you at the first, with the tag `q-<first id>` stamped on every question as `push_tag`. Once each question carrying that tag is answered or resolved, the queued push is dropped, by the CLI on a resolve and by the board server on an owner answer. A failed push leaves the questions written and prints `push not sent: <why>`.
- **Hold, Resume and Done.** The board server writes the owner's `card-hold` and `card-done` to the wave file as the event lands, with a thread line from the owner ("Held.", "Held until …", "Resumed.", "Marked done."), and a Done sends `card-unblocked` as `item set` does. The owner's line keeps their pending messages pending. The session only stops a builder ([the board applies the owner's Hold, Resume and Done at once](2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md), [a message or question on a Done card reopens it until the owner's Done](2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md)).
- **Builder choice.** `builder pick <key>` prints `codex` or `opus` and why, from the hub's effective Codex share and the pause line (`shared/usage-gate.mjs` `builderPick`). `builder start --kind codex|opus` refuses the kind the pick rules out, and `--kind build` records the pick.
- **Acting resolves.** `item set --status building`, `builder start`, and a `reply` to an ask or a wave triage resolve the answered questions on that card or topic, as a new question and notes already do ([an answered question stops waiting once Claude acts on its card](2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md)).
- **Reminders.** The board server appends `reminder {key, what, spell, since}` once per wait of 30 minutes: a card in Orchestrator review with no running builder, a message marked Working with no reply, or a wave triage with no reply. `data/reminders.json` and the event log keep it to one per wait across a restart, and the watcher holds it while work is paused.
- **Watcher Stop hook.** `hooks-plugin/hooks/watcher-stop.mjs`, run from settings.json's `Stop` hooks, blocks a turn from ending while a board the session owns has no live watcher, naming the relaunch command. It counts a watcher in `background_tasks` as live, since one launched that turn may not have written `data/watcher.json` yet. It never blocks a session that owns no board, and it lets the turn end when `stop_hook_active` is set.

An audit of the hub board's sessions found these steps skipped or done wrong: a question pushed queued under a made-up tag that went out after its answer, cards left in Orchestrator review, closings with no line, and watchers not relaunched. The owner picked each change above on hub/INT-209.

Considered:
- the session keeps each step, with sharper SKILL.md lines: the audit's misses came from those lines;
- `push --question <id>` filling the flags: the session still has to remember to run it;
- refusing `builder start --kind build` instead of mapping it through the pick: board sessions already start builders with it;
- registering the Stop hook in the plugin: the owner adds it to settings.json, so a host opts in.
