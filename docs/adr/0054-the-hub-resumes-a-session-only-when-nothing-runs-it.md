---
status: superseded in part by ADR-0061
---

# The hub resumes a session only when nothing runs it

Superseded in part by [0061](0061-a-boards-session-wakes-when-an-event-arrives.md): the hub resumes a session as soon as an event lands while it isn't running, and after 3 minutes not listening only when an event waits that it hasn't heard. A background session resumes with no flags, so it keeps its id, and the hub records the id it comes back under.

The manifest records each board's session (id, folder, optional model), and the hub resumes that session with `claude --resume <id> --bg` when its board hasn't listened for 3 minutes. It does so only when the session isn't live: no `~/.claude/sessions/<pid>.json` record names it with a process that still runs, started when the record says. It resumes once, then pushes the owner once if the board still isn't listening 5 minutes later. `web-ts start` and `web-ts resume` refuse a live session the same way.

`claude --resume --bg` on a session that is already running starts a copy of it. A watcher drops while its session stays alive in a terminal, so a missing watcher alone would give that session a second process working the same board.

The owner picked one hub session that starts and resumes every orchestrator as a background session, resuming a board whenever it stops listening (hub/INT-113, ha-restart).

Considered:
- resuming whenever the watcher is gone, which duplicates a terminal session that only lost its watcher;
- only pushing the owner, which needs them at the Mac to restart it.
