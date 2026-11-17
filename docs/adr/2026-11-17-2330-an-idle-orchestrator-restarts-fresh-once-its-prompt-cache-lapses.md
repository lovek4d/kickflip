# An idle orchestrator restarts fresh once its prompt cache lapses

Card #1014 (T-470). The owner asked (11/15): "What are your thoughts about whether we should have the orchestrator
simply restart from the board context after the prompt cache expires? Would it actually be beneficial to have the
current long running? Does it help us?" and answered (11/17): "Yes, when idle and the cache has lapsed".

A board's orchestrator session runs for days. Once its prompt cache lapses (an hour), its next wake re-reads the whole
long, several-times-compacted context uncached, the most expensive wake there is, and the long tail dilutes its
attention. What only that context holds is meant to be on the board anyway (notes, threads, waits, memory). This
supersedes resuming the long session at that point.

## Decision

- **When.** On each session check, after the wake (`hub/sessions.mjs` `freshIdleSessions`, the predicate
  `freshStartDue`), a board's orchestrator starts fresh when all hold:
  - its last turn, its transcript's last write (`hub/session-activity.mjs` `lastTurn`), is more than an hour ago;
  - it is listening, so a session that isn't goes through the resume path as before, and its record isn't busy;
  - no open wait in `data/orchestrator-waits.json` holds it: a `calls` wait (a builder handed back, waiting on verify)
    at any age, any wait picked up and not finished, or one unpicked for over a minute. A wait under a minute old is the
    new session's to pick up. A limbo wait is the orchestrator's backlog and never wakes it, so it holds nothing;
  - its board's usage isn't paused, as for the hub's restart.
- **One per lapse.** `~/.claude/kickflip/fresh-state.json` `{<route>: {session, at, error?}}` records the session the
  start made, or the old one when the start failed. That session is skipped until it takes a turn more than 15 minutes
  after `at`, so a fresh session that only joined and read its brief isn't restarted each idle hour, and a failed start
  isn't retried every check. The entry clears once the board's session is another.
- **How.** A background board uses `freshSession`: stop the old session, start a new one in its folder and model, and
  move the owner with its watcher cursor. The hub board, in tmux, uses `freshHubSession`: stop the old session, wait
  out its tmux session (`closeTmux`), move the owner and its watcher cursor to a new id, then start
  `claude --session-id <id>` in tmux with the board line (`hubArgv` fresh), which joins as the owner it already is. A
  tmux start that fails moves the owner back.
- **The brief.** The join of a session `fresh-state.json` names prints `brief`, the command
  `board.mjs --site <route> brief`, which the skill has the session run before going on: the cards In Progress with
  their builder state, the cards waiting on the owner, the owner's messages, asks and answers of the last 24 hours,
  and the path of Claude Code's memory index for the session's folder. The open waits print on the watcher's first
  wake. Anything the fresh session needed and couldn't find is a board gap to file.
- **Audit.** Each start and failure goes in the board's audit log as call `fresh`, with how long the session was idle.

## Consequences

- [A board session compacts before its context fills](2026-11-03-1823-a-board-session-compacts-before-its-context-fills.md)
  still covers a full context on a session that isn't listening; a fresh start needs a listening one, so the two never
  meet on one board.
- Claude Code stops a background session left idle unattached for about an hour, so a background board is often
  asleep by the time its cache lapses, and its next event resumes the long session as before. The fresh start mostly
  serves the hub board, whose session in tmux isn't stopped.
- Every fresh start is a test that the board holds what the orchestrator needs; each gap it finds is filed.

Considered: reading the cache's lapse from usage data. The transcript's last write is the last turn, which is what the
cache's lifetime runs from, and it costs one stat.
