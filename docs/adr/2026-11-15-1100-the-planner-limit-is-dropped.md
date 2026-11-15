# The Planner limit is dropped

Status: accepted. Supersedes the "Its own cap" decision in [every card arriving in Todo is grilled by the board](2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md); settles the open call in [every new ticket starts discussing](2026-11-15-1000-every-new-ticket-starts-discussing.md).

`max_planners` (Maximum parallel planners, 3 by default) only ever capped arrival grills. With those gone, a grill or prototype launches from the orchestrator's written brief at once, so the setting capped nothing.

Considered and rejected: applying the cap to brief launches and queuing the rest ("grill queued"). A planner is one Claude Code process whose model runs remotely, about 370 MB resident locally, so the cap buys little. Prototype planners also start a serve, and `max_serves` still caps that.

Dropped: the board.json key, `settings set max-planners`, the `POST /api/settings` field, the settings page row and `MAX_PLANNERS`. An old `max_planners` value in board.json is ignored. `max_implementers` and `max_serves` stay.
