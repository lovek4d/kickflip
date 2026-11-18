# The owner's words reach the orchestrator after its next tool call

A board's session hears the board through its watcher (`bin/wait-events.mjs`), which exits on the next event and is relaunched once the session has acted. Nothing is lost while the session works, but the owner's messages sent meanwhile sit unread until that relaunch, and an edit can land after the session acted on the first text (#503).

**A PostToolUse hook shows them mid-task.** The plugin runs `hooks-plugin/hooks/board-messages.mjs` after every tool call. For each board whose manifest owner is the calling session, it reads `data/events.jsonl` past the watcher's cursor (`data/.watch-cursor-<session>.json`) and returns, as `additionalContext`, each of the owner's own words not shown yet: `item-message`, `ask` and `ask-edited` (`bin/event-lines.mjs` `OWNER_WORDS`). Each one carries its sent time (the event's `ts`) and how long ago that was, so the session can tell an older message from a fresh one, then the plain line the watcher would print and the raw event line. Other kinds wait for the wake as before. A subagent's tool call carries `agent_id` under its parent's `session_id` and gets nothing; a session with no watcher cursor yet gets nothing.

**It marks them, and the wake prints them again.** The hook marks the kinds the watcher marks working (`WORKING_KINDS`) in `data/working.json`, so the thread reads thinking… at once, and records their ids in `data/.shown-<session>.json`. The watcher's next wake prints those events as usual, with the plain line prefixed `already shown: `. The hook drops ids from the shown file once the watcher's cursor has passed them.

**Instrumented first.** One throwaway `claude -p` run with a PostToolUse hook returning `additionalContext` confirmed that the text reaches the model in the running turn, after the tool call, and that a subagent's calls fire the hook with `agent_id` set and the same `session_id`.

**Labels.** The pending label on an owner message reads "waiting…" and the picked-up one "thinking…", lowercase, in the thread, on a New card's ask line and on a working card's line (`board/public/ui.js` `workingLine`, `ui-threads.js` `PICK_UP`, `ui-cards.js` `PICKUP_WAIT`).

**Not done.** Typing a notice into the hub board's tmux pane reaches only that board and queues as a prompt rather than landing mid-turn. Keeping an unread message pinned at the bottom of its thread was set aside by the owner.

**Amended 2026-11-18: the hook signals, and inbox read shows the words.** The hook now prints one signal line per new request and marks nothing; `board.mjs inbox read` prints the words, with their sent time and age, and marks them thinking…. The watcher's `already shown:` tag became `already read:` ([requests arrive as a signal, and inbox read hands over the words](2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md)).
